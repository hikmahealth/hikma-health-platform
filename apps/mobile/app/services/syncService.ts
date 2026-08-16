/**
 * Entry point for syncing with the configured peer, cloud or local hub.
 *
 * Owns the choice of sync route, the mutex that stops concurrent runs, and the
 * XState store the UI reads. The transports themselves live in `db/peerSync.ts`
 * and `db/cloudManualSync.ts`.
 */

import { Alert } from "react-native"
import { hasUnsyncedChanges } from "@nozbe/watermelondb/sync"
import { getLastPulledAt } from "@nozbe/watermelondb/sync/impl"
import * as Sentry from "@sentry/react-native"
import Toast from "react-native-root-toast"

import database, { databaseReady } from "@/db"
import { runManualSync } from "@/db/cloudManualSync"
import { getCredentials, syncDB } from "@/db/peerSync"
import { translate } from "@/i18n/translate"
import Peer from "@/models/Peer"
import Sync from "@/models/Sync"
import User from "@/models/User"
import { operationModeStore } from "@/store/operationMode"
import { syncStore } from "@/store/sync"
import { withSyncLock, isSyncInFlight, currentSyncLabel } from "@/services/syncLock"
import { Logger } from "@hikmahealth/js-utils"

let ordinarySyncInFlight: Promise<void> | null = null

/**
 * Who asked for this sync.
 *
 * `user` waits its turn — someone pressed a button and expects it to happen.
 * `auto` (connectivity settle, login, foreground) gives up instead of queueing
 * behind a long manual sync, since nobody is waiting on the result and several
 * stacked triggers would all fire at once on release.
 */
export type SyncTrigger = "user" | "auto"

/**
 * How long the unattended first-sync backfill may run before it is aborted.
 *
 * Not a transfer budget — a real first sync of a large clinic can legitimately
 * take many minutes. This exists so a hung socket or a device that never
 * regains connectivity cannot hold the sync lock forever, since this is the one
 * backfill with no user and no Cancel button behind it.
 */
const FIRST_SYNC_CEILING_MS = 30 * 60_000

/**
 * Sync with the active peer.
 *
 * Worth calling twice in a row: the first run is PULL → conflict resolution →
 * PUSH, the second is a PULL with nothing left to push, which is what picks up
 * server-side values the push itself changed (stock counts, for one).
 *
 * Resolution does not mean work happened — an `auto` trigger also resolves when
 * another sync holds the lock. Rejects on a test account, a missing peer, or a
 * transport failure.
 */
export const startSync = async (
  providerEmail?: string,
  options?: { trigger?: SyncTrigger },
): Promise<void> => {
  // Before the mutex, not inside it: this resolves immediately on all but the
  // first cold start, and holding the lock across it would make every caller
  // that joins `ordinarySyncInFlight` wait on it too.
  await databaseReady

  if (operationModeStore.getSnapshot().context.mode === "online") {
    Logger.log("Skipping sync: app is in online mode")
    return Promise.resolve()
  }

  if (providerEmail === "tester.g@gmail.com") {
    Alert.alert("Please sign in with your server to continue syncing")
    return Promise.reject(new Error("Test account cannot sync"))
  }

  // Mutex. `ordinarySyncInFlight` is assigned below with no await in between, so
  // two callers racing across the login / netinfo settle both see it and join
  // rather than starting a second synchronize() that WatermelonDB would abort.
  // Checked before the lock so an automatic trigger keeps joining an ordinary
  // sync exactly as it did before the lock existed.
  if (ordinarySyncInFlight) {
    Logger.log("Sync already in progress, joining existing run...")
    return ordinarySyncInFlight
  }

  // Something else — a manual sync — holds the lock. Queueing an automatic
  // trigger behind it helps nobody, so drop it; the run it would have waited for
  // covers the same ground.
  if (options?.trigger === "auto" && isSyncInFlight()) {
    Logger.log(`Skipping automatic sync: "${currentSyncLabel()}" holds the sync lock`)
    return Promise.resolve()
  }

  // Defaults to queueing. A delayed sync is recoverable; a skipped one may not be.
  ordinarySyncInFlight = runFirstSyncThenOrdinary(providerEmail).finally(() => {
    ordinarySyncInFlight = null
  })
  return ordinarySyncInFlight
}

/**
 * Take the paged backfill when this device has never synced, then fall back to
 * the ordinary path if it did not complete.
 *
 * The two runs claim the sync lock in sequence, never nested. `runManualSync`
 * claims it itself, and `withSyncLock` has no owner tracking, so claiming from
 * inside a locked region deadlocks permanently.
 */
const runFirstSyncThenOrdinary = async (providerEmail?: string): Promise<void> => {
  const firstSyncPeer = await resolveFirstSyncPeer()
  if (firstSyncPeer && (await runFirstSyncBackfill(firstSyncPeer))) return

  await withSyncLock("ordinary", () => runSync(providerEmail))
}

/**
 * The active peer if this device has never synced and that peer is a cloud
 * server, otherwise null.
 *
 * `getLastPulledAt` returns null for never-synced and a number otherwise. A
 * watermark of 0 means "synced, everything since epoch" — collapsing it to null
 * would send those devices through a full backfill on every launch.
 */
const resolveFirstSyncPeer = async (): Promise<Peer.T | null> => {
  try {
    const activePeers = await Peer.DB.getActive()
    const activePeer = activePeers[activePeers.length - 1]
    if (!activePeer || activePeer.peerType !== "cloud_server") return null

    return (await getLastPulledAt(database)) === null ? activePeer : null
  } catch (error) {
    // Deciding the route must never be what stops a sync. Ordinary sync
    // resolves the peer again and reports its own failures.
    Logger.warn({ msg: "[Sync] Could not determine first-sync eligibility", error })
    return null
  }
}

/**
 * Pull the initial dataset through the paged backfill.
 *
 * Returns false if it did not complete, and the caller falls back to the
 * ordinary unbounded pull — what every device does today, so trying the paged
 * path first can only improve on it. Do not clear the resume cursor here: a
 * resumable failure leaves it in place so the next launch continues the paged
 * run rather than restarting it, and that is what makes the fallback safe.
 */
const runFirstSyncBackfill = async (peer: Peer.T): Promise<boolean> => {
  // `fetch` has no timeout and nothing here can be cancelled by a user, so a
  // socket that never answers would hold the sync lock for the life of the
  // process.
  const controller = new AbortController()
  const ceiling = setTimeout(() => controller.abort(), FIRST_SYNC_CEILING_MS)

  try {
    Logger.log({ msg: "[Sync] First sync — routing through the paged backfill", peer: peer.id })

    // Mirrors syncCloud: refresh clinic and roles first. This is the run where
    // the provider record is least established, so it matters most here.
    const { email, password } = await getCredentials()
    await User.signIn(email, password)

    const result = await runManualSync({
      peerId: peer.id,
      since: 0,
      signal: controller.signal,
      onProgress: (progress) => Logger.log({ msg: "[Sync] Backfill progress", ...progress }),
    })

    if (!result.ok) {
      Logger.warn({
        msg: "[Sync] First-sync backfill failed — falling back to the ordinary pull",
        error: result.error,
        resumable: result.resumable,
        timedOut: controller.signal.aborted,
      })
      Sentry.captureMessage(`First-sync backfill failed: ${result.error}`, { level: "warning" })
      return false
    }

    Logger.log({ msg: "[Sync] First-sync backfill complete", applied: result.recordsApplied })
    return true
  } catch (error) {
    Logger.warn({ msg: "[Sync] First-sync backfill threw — falling back", error })
    Sentry.captureException(error)
    return false
  } finally {
    clearTimeout(ceiling)
  }
}

// Re-pairing only happens on the login screen, so signing out is the only way
// forward — hence one button and no dismiss.
const promptSignInAfterDisconnect = (): void => {
  Alert.alert(
    translate("login:disconnectedTitle"),
    translate("login:disconnectedMessage"),
    [
      {
        text: translate("login:signIn"),
        onPress: () => {
          User.signOut().catch((error) =>
            Logger.error({ msg: "[Sync] Sign out after disconnect failed", error }),
          )
        },
      },
    ],
    { cancelable: false },
  )
}

const runSync = async (providerEmail?: string): Promise<void> => {
  try {
    const activePeers = await Peer.DB.getActive()
    const activePeer = activePeers.pop()
    if (activePeers.length > 0) {
      // Not awaited — a failed deactivation should not stop the sync.
      Peer.DB.deactivatePeersById(activePeers.map((it) => it.id)).catch((error) =>
        Logger.log({ error }),
      )
    }
    if (!activePeer) {
      promptSignInAfterDisconnect()
      return Promise.reject(new Error("No active sync peer"))
    }

    const hasLocalChangesToPush = await hasUnsyncedChanges({ database })

    Toast.show(translate("common:syncStarted"), {
      position: Toast.positions.BOTTOM,
      containerStyle: {
        marginBottom: 100,
      },
    })

    const finishSync = () => syncStore.send({ type: "finish_sync" })

    return syncDB(activePeer.id, {
      hasLocalChangesToPush,
      setSyncStart: () => syncStore.send({ type: "start_sync" }),
      setSyncResolution: (fetched: number) => syncStore.send({ type: "start_resolve", fetched }),
      setPushStart: (pushed: number) => syncStore.send({ type: "start_push", pushed }),
      updateSyncStatistic: Logger.log,
      onSyncError: (error: string) => syncStore.send({ type: "error_sync", error }),
      onSyncCompleted: finishSync,
    }).catch((err) => {
      finishSync()
      Logger.error({ msg: "Sync error:", err })

      const isConcurrent = String(err).includes("Concurrent synchronization")
      if (!isConcurrent) {
        const isHub = activePeer.peerType === "sync_hub"
        Toast.show(
          isHub
            ? "Error syncing locally. Please make sure you are on the same network and Wi-Fi is enabled."
            : "Error syncing. Please make sure you have internet or contact your administrator.",
          {
            position: Toast.positions.BOTTOM,
            containerStyle: { marginBottom: 100 },
            duration: Toast.durations.LONG,
          },
        )
      }

      Sentry.captureException(err)
      throw err
    })
  } catch (error) {
    Logger.error({ msg: "Sync initialization error:", error })
    Sentry.captureException(error)
    throw error
  }
}

/** Whether this device has been paired with a peer on the admin portal. */
export const isSyncAvailable = async (): Promise<boolean> => {
  try {
    const peer = await Peer.DB.resolveActive()
    return peer !== null
  } catch {
    return false
  }
}

export const getSyncState = (): Sync.StateT => {
  return syncStore.getSnapshot().context.state
}

export const isSyncing = (): boolean => {
  return getSyncState() !== Sync.State.IDLE
}
