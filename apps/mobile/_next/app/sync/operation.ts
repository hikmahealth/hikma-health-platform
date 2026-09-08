// ===========================================================================
// Actors (side-effects)
//
// These live *outside* the machine. Each is a standalone actor that performs
// one async unit of work in the sync pipeline and receives the resolved store
// dependencies as `input`. The orchestration runs them and sends the
// corresponding events to the machine.
//
// Only cloud-server (`cloudUrl`) peers are implemented here; a `sync_hub` peer
// throws until the encrypted-RPC transport is wired into this pipeline.
// ===========================================================================

import { Buffer } from "buffer"
import { fromPromise } from "xstate"
import type { SyncDatabaseChangeSet, Timestamp } from "@nozbe/watermelondb/sync"
import { getLastPulledAt, setLastPulledAt } from "@nozbe/watermelondb/sync/impl"
import { Logger } from "@hikmahealth/js-utils"

import database, { databaseReady } from "@/db"
import { applyRemoteChanges, fetchLocalChanges, markLocalChangesAsSynced } from "@/db/localSync"
import { countRecordsInChanges, updateDates } from "@/db/syncNormalize"
import { getCredentials } from "@/db/peerSync"
import schema from "@/db/schema"
import User from "@/models/User"

import { SyncSession } from "./store"

/** `/api/v2/sync` is cloud-only; the hub serves no such route. */
const SYNC_PATH = "/api/v2/sync"

/** The pulled payload the cloud sync endpoint returns. */
export type PulledChanges = { changes: SyncDatabaseChangeSet; timestamp: Timestamp }

/** Input for `pushToServer`: the session plus the changeset to upload. */
export type PushInput = { session: SyncSession; changes: SyncDatabaseChangeSet }

/** Input for `applyToDatabase`: the session plus the pulled payload to apply. */
export type ApplyInput = { session: SyncSession; pulled: PulledChanges }

/**
 * Narrow a session to its cloud URL. Cloud is the only transport implemented in
 * this pipeline; anything else (a hub) is rejected, which surfaces as an actor
 * error and routes the machine to `errored`.
 */
function requireCloudUrl(session: SyncSession): string {
  if (session.peer.type !== "cloud_server") {
    throw new Error(
      `[sync] cloud sync only supports cloud_server peers (got: ${session.peer.type})`,
    )
  }
  return session.peer.url
}

/** HTTP Basic auth headers from the stored provider credentials. */
function buildAuthHeaders(email: string, password: string): Headers {
  const encoded = Buffer.from(`${email}:${password}`).toString("base64")
  const headers = new Headers()
  headers.append("Authorization", `Basic ${encoded}`)
  return headers
}

/**
 * `pushing`: read the pending local data out of the device database.
 */
export const collectLocalChanges = fromPromise<SyncDatabaseChangeSet, SyncSession>(
  async ({ input }) => {
    requireCloudUrl(input)
    await databaseReady

    const changes = await fetchLocalChanges()
    Logger.log({
      msg: `[sync] collected ${countRecordsInChanges(changes)} local record(s) to push`,
    })
    return changes
  },
)

/**
 * `pushing`: send the collected local data to the provider server, then mark it
 * as synced so it is not offered again.
 */
export const pushToServer = fromPromise<void, PushInput>(async ({ input }) => {
  const { session, changes } = input
  const cloudUrl = requireCloudUrl(session)

  if (countRecordsInChanges(changes) === 0) {
    Logger.log({ msg: "[sync] nothing to push" })
    return
  }

  const { email, password } = await getCredentials()
  const headers = buildAuthHeaders(email, password)
  headers.set("Content-Type", "application/json")

  const lastPulledAt = (await getLastPulledAt(database)) ?? 0
  const response = await fetch(`${cloudUrl}${SYNC_PATH}?last_pulled_at=${lastPulledAt}`, {
    method: "POST",
    headers,
    body: JSON.stringify(changes),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Cloud sync push failed (${response.status}): ${errorText}`)
  }

  await markLocalChangesAsSynced(changes)
  Logger.log({ msg: "[sync] pushed local changes to cloud" })
})

/**
 * `pulling`: request data from the provider server.
 */
export const pullFromPeerServer = fromPromise<PulledChanges, SyncSession>(async ({ input }) => {
  const cloudUrl = requireCloudUrl(input)

  const { email, password } = await getCredentials()
  // Refreshes clinic and roles, which the pulled records are scoped against.
  await User.signIn(email, password, cloudUrl)

  const headers = buildAuthHeaders(email, password)
  const lastPulledAt = (await getLastPulledAt(database)) ?? 0
  const params = new URLSearchParams({
    last_pulled_at: String(lastPulledAt),
    schema_version: String(schema.version),
    // No migration payload: the manual pipeline does not report schema
    // migrations to the server (that is `synchronize()`'s job).
    migration: JSON.stringify(null),
  })

  const response = await fetch(`${cloudUrl}${SYNC_PATH}?${params.toString()}`, { headers })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Cloud sync pull failed (${response.status}): ${errorText}`)
  }

  const { changes, timestamp } = (await response.json()) as PulledChanges
  Logger.log({ msg: `[sync] pulled ${countRecordsInChanges(changes)} record(s) from cloud` })
  return { changes, timestamp }
})

/**
 * `pulling`: apply the pulled data to the device database and advance the
 * last-pulled watermark.
 */
export const applyToDatabase = fromPromise<void, ApplyInput>(async ({ input }) => {
  const { session, pulled } = input
  requireCloudUrl(session)
  await databaseReady

  // Translate Postgres wire types (ISO dates, JSONB) into WatermelonDB values.
  updateDates(pulled.changes)
  await applyRemoteChanges(pulled.changes)
  await setLastPulledAt(database, pulled.timestamp)

  Logger.log({ msg: "[sync] applied remote changes to the device database" })
})
