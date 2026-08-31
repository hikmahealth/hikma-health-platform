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
import type { RpcResult } from "@/rpc/types"
import type { RpcTransport } from "@/rpc/transport"
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
 * How long a sync request may go entirely unanswered. Generous because
 * `/api/v2/sync` serialises the whole change set before it replies.
 */
const SYNC_RESPONSE_TIMEOUT_MS = 5 * 60_000

/**
 * `fetch`, abandoned if the server never begins answering.
 *
 * Bounds the wait for a response, not the download — the timer is cleared once
 * the headers arrive, so a large pull still transfers at whatever pace it needs.
 * Without this, an unanswered socket pins the sync lock for the life of the
 * process and every later sync joins a run that can never end.
 */
const fetchAnswered = async (url: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SYNC_RESPONSE_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/** Exported so the first-sync backfill reads credentials the same way. */
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

/** `/api/v2/sync` is cloud-only; the hub serves no such route. */
const getCloudBaseUrl = (peer: Peer.T): string => {
  const url = Peer.getUrl(peer)
  if (!url) throw new Error("HH API URL not found")
  return url
}

const syncCloud = async (peer: Peer.T, callbacks: SyncCallbacks): Promise<void> => {
  const { email, password } = await getCredentials()
  const cloudUrl = getCloudBaseUrl(peer)
  const SYNC_API = `${cloudUrl}/api/v2/sync`

  // Refreshes clinic and roles, which the pull below depends on.
  await User.signIn(email, password, cloudUrl)

  const headers = buildBasicAuthHeaders(email, password)

  callbacks.setSyncStart()

  await synchronize({
    database,
    sendCreatedAsUpdated: false,
    pullChanges: async ({ lastPulledAt, schemaVersion, migration }) => {
      const pullStart = Date.now()
      const urlParams = `last_pulled_at=${lastPulledAt || 0}&schema_version=${schemaVersion}&migration=${encodeURIComponent(JSON.stringify(migration))}`

      const response = await fetchAnswered(`${SYNC_API}?${urlParams}`, { headers })
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

      const response = await fetchAnswered(`${SYNC_API}?last_pulled_at=${lastPulledAt || 0}`, {
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

  let transport = await Peer.Hub.getTransport()
  if (!transport) {
    throw new Error("Hub not connected — pair with a hub first")
  }

  const lastPulledAt = peer.lastSyncedAt ?? 0
  const readToken = async (): Promise<string | undefined> =>
    getResultData(await Peer.Session.getTokenByPeerId(peer.peerId), undefined)
  let token = await readToken()
  // The token is deliberately absent from this log: it is a credential.
  logger.log("[HUB SYNC]", { lastPulledAt, peer: JSON.stringify(peer, null, 2) })

  /**
   * Run one hub call, refreshing the session token if the hub rejects it.
   *
   * Scoped to a single call, not the whole sync: by the time a push fails the
   * pull has already applied remote changes, so rerunning it is a second write.
   *
   * The transport is rebuilt after a refresh because it captures the token at
   * construction and would otherwise keep sending the dead one.
   */
  const authed = async <T>(
    run: (t: RpcTransport, tok: string | undefined) => Promise<RpcResult<T>>,
  ): Promise<RpcResult<T>> => {
    const first = await run(transport!, token)
    if (first.ok || first.error.code !== "AUTH_FAILED") return first

    Logger.warn({ msg: "[Sync] hub rejected the session token, refreshing once" })
    if (!(await Peer.Hub.refreshToken())) return first

    const refreshed = await Peer.Hub.getTransport()
    if (!refreshed) return first
    transport = refreshed
    token = await readToken()
    return run(transport, token)
  }

  const pullResult = await authed((t, tok) =>
    t.sendQuery<SyncPullResponse>("sync_pull", { lastPulledAt }, tok),
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
    const pushResult = await authed((t, tok) =>
      t.sendCommand("sync_push", { changes: localChanges, lastPulledAt }, tok),
    )
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
