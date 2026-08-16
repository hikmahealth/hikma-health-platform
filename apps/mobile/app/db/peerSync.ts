/**
 * Sync against any peer in the `peers` table, dispatching on `peer.peerType`:
 *
 *   cloud_server → WatermelonDB synchronize() over HTTPS
 *   sync_hub     → encrypted RPC + manual change application
 */

import * as EncryptedStorage from "expo-secure-store"
import { SyncDatabaseChangeSet, synchronize, Timestamp } from "@nozbe/watermelondb/sync"
import * as Sentry from "@sentry/react-native"

import { getResultData } from "../../types/data"

import Peer from "@/models/Peer"
import User from "@/models/User"
import { logger } from "@/utils/logger"

import { applyRemoteChanges, fetchLocalChanges, markLocalChangesAsSynced } from "./localSync"
import { countRecordsInChanges, updateDates } from "./syncNormalize"

import database, { databaseReady } from "."
import { Logger } from "@hikmahealth/js-utils"

global.Buffer = require("buffer").Buffer

export type SyncCallbacks = {
  hasLocalChangesToPush: boolean
  setSyncStart: () => void
  setSyncResolution: (records: number) => void
  setPushStart: (pushed: number) => void
  updateSyncStatistic: (stats: { fetched: number; pushed: number }) => void
  onSyncError: (error: string) => void
  onSyncCompleted: () => void
}

type SyncPullResponse = {
  changes: SyncDatabaseChangeSet
  timestamp: number
}

/**
 * Exported so the first-sync backfill reads credentials the same way this module
 * does, rather than growing a second definition of where they live.
 */
export const getCredentials = async (): Promise<{ email: string; password: string }> => {
  const email = await EncryptedStorage.getItem("provider_email")
  const password = await EncryptedStorage.getItem("provider_password")
  if (!email || !password) throw new Error("No credentials found. Please sign in.")
  return { email, password }
}

const buildBasicAuthHeaders = (email: string, password: string): Headers => {
  const encoded = Buffer.from(`${email}:${password}`).toString("base64")
  const headers = new Headers()
  headers.append("Authorization", `Basic ${encoded}`)
  return headers
}

const getSyncApiUrl = async (): Promise<string> => {
  const url = await Peer.getActiveUrl()
  if (!url) throw new Error("HH API URL not found")
  return `${url}/api/v2/sync`
}

const syncCloud = async (peer: Peer.T, callbacks: SyncCallbacks): Promise<void> => {
  const { email, password } = await getCredentials()

  // Refreshes clinic and roles, which the pull below depends on.
  await User.signIn(email, password)

  const headers = buildBasicAuthHeaders(email, password)
  const SYNC_API = await getSyncApiUrl()

  callbacks.setSyncStart()

  await synchronize({
    database,
    sendCreatedAsUpdated: false,
    pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
      const pullStart = Date.now()
      const urlParams = `last_pulled_at=${lastPulledAt || 0}&schema_version=${schemaVersion}&migration=${encodeURIComponent(JSON.stringify(migration))}`

      const response = await fetch(`${SYNC_API}?${urlParams}`, { headers })
      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Cloud sync pull failed (${response.status}): ${errorText}`)
      }

      const { changes, timestamp }: { changes: SyncDatabaseChangeSet; timestamp: Timestamp } =
        await response.json()

      updateDates(changes)

      const fetched = countRecordsInChanges(changes)
      Logger.log({ msg: `[Cloud Sync] Pulled ${fetched} records (${Date.now() - pullStart}ms)` })
      callbacks.setSyncResolution(fetched)

      if (!callbacks.hasLocalChangesToPush) {
        setTimeout(() => callbacks.onSyncCompleted(), 2_500)
      }

      return { changes, timestamp }
    },
    pushChanges: async ({ changes, lastPulledAt }) => {
      callbacks.setPushStart(countRecordsInChanges(changes))

      const pushHeaders = new Headers(headers)
      pushHeaders.set("Content-Type", "application/json")

      const response = await fetch(`${SYNC_API}?last_pulled_at=${lastPulledAt || 0}`, {
        method: "POST",
        headers: pushHeaders,
        body: JSON.stringify(changes),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Cloud sync push failed (${response.status}): ${errorText}`)
      }

      callbacks.onSyncCompleted()
    },
    migrationsEnabledAtVersion: 1,
  })

  await Peer.DB.updateLastSyncedAt(peer.id, Date.now())
}

const syncHub = async (peer: Peer.T, callbacks: SyncCallbacks): Promise<void> => {
  callbacks.setSyncStart()

  const transport = await Peer.Hub.getTransport()
  if (!transport) {
    throw new Error("Hub not connected — pair with a hub first")
  }

  const lastPulledAt = peer.lastSyncedAt ?? 0
  const token_res = await Peer.Session.getTokenByPeerId(peer.peerId)
  const token = getResultData(token_res, undefined)
  logger.log("[HUB SYNC]", { lastPulledAt, peer: JSON.stringify(peer, null, 2), token })

  const pullResult = await transport.sendQuery<SyncPullResponse>(
    "sync_pull",
    { lastPulledAt },
    token,
  )
  logger.log("[Sync] After pullResult: ", pullResult)
  if (!pullResult.ok) {
    throw new Error(`sync_pull failed: ${pullResult.error.message}`)
  }

  const { changes, timestamp } = pullResult.data
  const fetchedCount = countRecordsInChanges(changes)
  Logger.log({ msg: "[Sync] fetched count: ", fetchedCount })
  callbacks.setSyncResolution(fetchedCount)

  await applyRemoteChanges(changes)

  const localChanges = await fetchLocalChanges()
  const pushCount = countRecordsInChanges(localChanges)
  callbacks.setPushStart(pushCount)

  if (pushCount > 0) {
    const pushResult = await transport.sendCommand("sync_push", {
      changes: localChanges,
      lastPulledAt,
    })
    if (!pushResult.ok) {
      throw new Error(`sync_push failed: ${pushResult.error.message}`)
    }

    await markLocalChangesAsSynced(localChanges)
  }

  await Peer.DB.updateLastSyncedAt(peer.id, timestamp)
  callbacks.onSyncCompleted()
}

const strategies: Record<Peer.PeerType, (peer: Peer.T, cb: SyncCallbacks) => Promise<void>> = {
  cloud_server: syncCloud,
  sync_hub: syncHub,
  mobile_app: () => {
    throw new Error("Cannot sync with a mobile_app peer directly")
  },
}

/**
 * Sync the local database with the peer holding this WatermelonDB record id.
 */
export const syncDB = async (peerId: string, callbacks: SyncCallbacks): Promise<void> => {
  // Reached directly as well as via `startSync`, so it gates for itself.
  await databaseReady

  const peer = await Peer.DB.getById(peerId)

  const strategy = strategies[peer.peerType]
  if (!strategy) {
    throw new Error(`Unknown peer type: ${peer.peerType}`)
  }

  Sentry.addBreadcrumb({
    category: "peer-sync",
    message: `Starting sync with ${peer.peerType} peer`,
    level: "info",
    data: { peerId: peer.peerId, peerType: peer.peerType },
  })

  try {
    await strategy(peer, callbacks)
  } catch (error) {
    Sentry.captureException(error, {
      tags: { component: "peer-sync", peerType: peer.peerType },
    })
    callbacks.onSyncError(String(error))
    throw error
  }
}
