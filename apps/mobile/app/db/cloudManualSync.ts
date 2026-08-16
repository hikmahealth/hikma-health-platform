/**
 * Manual ("Sync from…") cloud sync: push everything pending, then pull a
 * keyset-paginated backfill from a chosen point in time, one page per write
 * transaction so memory does not grow with the transfer.
 *
 * Push-then-pull, unlike ordinary sync: recovery devices carry a backlog of
 * unpushed edits, and offering them before overwriting local state is what stops
 * the server's staleness guard discarding them.
 *
 * Kept separate from `peerSync.ts`, the rollback target — shared helpers go in
 * `syncNormalize.ts` and this must not import from `peerSync.ts`.
 */

import { Platform } from "react-native"

import { SyncDatabaseChangeSet, SyncLocalChanges, SyncRejectedIds } from "@nozbe/watermelondb/sync"
import {
  applyRemoteChanges,
  fetchLocalChanges,
  getLastPulledAt,
  markLocalChangesAsSynced,
  setLastPulledAt,
} from "@nozbe/watermelondb/sync/impl"
import { Logger } from "@hikmahealth/js-utils"

import Peer from "@/models/Peer"
import { createTrpcCloudTransport } from "@/rpc/transport"
import type { RpcResult } from "@/rpc/types"
import { pickPageBudget } from "@/services/pageBudget"
import { syncStore } from "@/store/sync"
import { withRetry } from "@/services/syncRetry"
import { withSyncLock } from "@/services/syncLock"
import { getBearerToken, refreshBearerToken } from "@/utils/authHeader"

import database, { databaseReady } from "."
import { INBOUND_TABLES, OUTBOUND_TABLES } from "./localSync"
import { countRecordsInChanges, updateDates } from "./syncNormalize"

/**
 * Rows per table bucket — mirrors the server's `MAX_PAGE_ROWS` and must move
 * with it, since asking for more is silently clamped. Sending it explicitly is
 * load-bearing: the server's default of 500 caps a bucket under even the
 * smallest byte budget, so every `pickPageBudget` tier would page identically.
 */
const PULL_PAGE_ROWS = 2_000

/**
 * Records per push request. Does not bound the fetch — `fetchLocalChanges`
 * materialises everything at once and upstream cannot page it — but bounds the
 * JSON string, request body, and server-side parse built on top of it.
 */
const PUSH_CHUNK_RECORDS = 2_000

/**
 * Pages one pull may walk before giving up — 200 million records, far above any
 * real dataset. It exists so a server bug that returns a constant non-null
 * cursor ends as a resumable failure rather than spinning forever.
 */
const MAX_PULL_PAGES = 100_000

type RawRow = Record<string, unknown>
type Bucket = { created: RawRow[]; updated: RawRow[]; deleted: string[] }

export type PullPage = {
  changes: SyncDatabaseChangeSet
  next_cursor: string | null
  timestamp: number
  progress: { table: string; bucket: string; tables_remaining: number } | null
}

type FetchPageFn = (args: { since: number; cursor: string | null }) => Promise<RpcResult<PullPage>>

export type PullLoopResult =
  | { ok: true; recordsApplied: number; pagesApplied: number; snapshotTs: number | null }
  | { ok: false; error: string; resumable: boolean }

export type ManualSyncProgress = {
  phase: "pushing" | "pulling" | "done"
  table: string
  pagesApplied: number
  recordsApplied: number
  recordsPushed: number
  rejectedCount: number
  tablesRemaining: number
}

export type ManualSyncResult =
  | { ok: true; recordsPushed: number; recordsApplied: number; rejected: SyncRejectedIds }
  | { ok: false; error: string; resumable: boolean }

/**
 * Normalise one inbound page. Each step guards a way upstream would otherwise
 * fail the whole page: `created` merges into `updated` (the server classifies
 * against the CURSOR, not against what this device holds, so the split is not
 * trustworthy); unknown tables are dropped (`db.get` throws on them); and
 * `_status`/`_changed`/`__proto__` are stripped as upstream treats all three as
 * fatal invariants.
 *
 * `knownTables` is a parameter rather than a database read to keep this pure.
 */
export function prepareInboundPage(
  changes: SyncDatabaseChangeSet,
  knownTables: ReadonlySet<string>,
): SyncDatabaseChangeSet {
  const out: Record<string, Bucket> = {}

  for (const [table, bucket] of Object.entries(changes ?? {})) {
    if (!INBOUND_TABLES.has(table)) {
      Logger.warn({ msg: "[manualSync] Ignoring table a peer may not write", table })
      continue
    }
    if (!knownTables.has(table)) {
      Logger.warn({ msg: "[manualSync] Ignoring table absent from local schema", table })
      continue
    }

    const b = (bucket ?? {}) as Partial<Bucket>
    const rows = [...(b.created ?? []), ...(b.updated ?? [])]
      .filter((raw) => {
        if (!raw || typeof raw !== "object") return false
        if (Object.prototype.hasOwnProperty.call(raw, "__proto__")) {
          Logger.warn({ msg: "[manualSync] Dropping record with own __proto__", table })
          return false
        }
        return true
      })
      .map((raw) => {
        const { _status, _changed, ...rest } = raw as RawRow
        return rest
      })

    const deleted = b.deleted ?? []
    if (rows.length === 0 && deleted.length === 0) continue

    out[table] = { created: [], updated: rows, deleted }
  }

  return out as SyncDatabaseChangeSet
}

/**
 * Split pending local changes into requests of at most `maxRecords` rows,
 * keeping only tables this device may send.
 *
 * The filter is not optional — `fetchLocalChanges` reports every collection,
 * including device-local `peers`, which holds hub URLs and public keys — and it
 * runs in the same pass as the split so a second full changeset is never
 * materialised. Each chunk carries only its own `affectedRecords`, since
 * `markLocalChangesAsSynced` logs an error for any raw it cannot find.
 */
export function chunkLocalChanges(
  local: SyncLocalChanges,
  maxRecords: number,
  allowedTables: ReadonlySet<string> = OUTBOUND_TABLES,
): SyncLocalChanges[] {
  const modelsByKey = new Map<string, unknown>()
  for (const model of local.affectedRecords ?? []) {
    const m = model as unknown as { id: string; table: string }
    modelsByKey.set(`${m.table}/${m.id}`, model)
  }

  const chunks: SyncLocalChanges[] = []
  let changes: Record<string, Bucket> = {}
  let affected: unknown[] = []
  let count = 0

  const bucketFor = (table: string): Bucket => {
    if (!changes[table]) changes[table] = { created: [], updated: [], deleted: [] }
    return changes[table]
  }

  const flush = () => {
    if (count === 0) return
    chunks.push({ changes, affectedRecords: affected } as SyncLocalChanges)
    changes = {}
    affected = []
    count = 0
  }

  for (const [table, bucket] of Object.entries(
    (local.changes ?? {}) as Record<string, Partial<Bucket>>,
  )) {
    if (!allowedTables.has(table)) continue

    // Preserved here even though `prepareInboundPage` discards it: outbound,
    // this device genuinely knows which rows it created.
    for (const bucketKey of ["created", "updated"] as const) {
      for (const row of bucket[bucketKey] ?? []) {
        bucketFor(table)[bucketKey].push(row)
        const model = modelsByKey.get(`${table}/${(row as { id: string }).id}`)
        if (model) affected.push(model)
        if (++count >= maxRecords) flush()
      }
    }
    for (const id of bucket.deleted ?? []) {
      bucketFor(table).deleted.push(id)
      if (++count >= maxRecords) flush()
    }
  }
  flush()

  return chunks
}

/**
 * Walk the server's pages until it stops issuing cursors, persisting each resume
 * cursor before the next request so an interrupted run continues rather than
 * restarts. The final page's cursor is deliberately not persisted — the caller
 * advances the real sync watermarks instead.
 *
 * Dependencies are arguments so this is testable without a database or network.
 */
export async function pullLoop(args: {
  fetchPage: FetchPageFn
  since: number
  startCursor: string | null
  signal: AbortSignal
  apply: (changes: SyncDatabaseChangeSet) => Promise<number>
  saveResume: (state: Peer.ResumeState) => Promise<void>
  onProgress: (p: {
    table: string
    pagesApplied: number
    recordsApplied: number
    tablesRemaining: number
  }) => void
}): Promise<PullLoopResult> {
  const { fetchPage, since, startCursor, signal, apply, saveResume, onProgress } = args

  let cursor = startCursor
  let pagesApplied = 0
  let recordsApplied = 0
  let snapshotTs: number | null = null

  for (;;) {
    if (signal.aborted) return { ok: false, error: "Cancelled", resumable: true }

    const result = await fetchPage({ since, cursor })
    if (!result.ok) {
      // Cancelling surfaces as a non-retryable error, so resumability cannot be
      // read from `retryable` alone: an aborted run's cursor is still good.
      if (signal.aborted) return { ok: false, error: "Cancelled", resumable: true }
      // Retries happen inside fetchPage, so reaching here means it gave up — but
      // a retryable class of failure still leaves the cursor standing.
      return {
        ok: false,
        error: result.error.message,
        resumable: result.error.retryable !== false,
      }
    }

    const page = result.data
    snapshotTs = page.timestamp

    recordsApplied += await apply(page.changes)
    pagesApplied += 1

    onProgress({
      table: page.progress?.table ?? "",
      pagesApplied,
      recordsApplied,
      tablesRemaining: page.progress?.tables_remaining ?? 0,
    })

    cursor = page.next_cursor
    if (cursor === null) return { ok: true, recordsApplied, pagesApplied, snapshotTs }

    if (pagesApplied >= MAX_PULL_PAGES) {
      return { ok: false, error: "Server kept issuing pages", resumable: true }
    }

    // Aborting between apply and save loses one page of progress, not
    // correctness — every applied record is `synced` and idempotent.
    await saveResume({ cursor, since, snapshotTs, pagesApplied, recordsApplied })
  }
}

/**
 * Apply one page inside a single write transaction. Upstream's
 * `applyRemoteChanges` does not open its own, and one write per page is what
 * bounds memory — wrapping the whole run in one transaction would not.
 */
async function applyPage(
  changes: SyncDatabaseChangeSet,
  knownTables: ReadonlySet<string>,
): Promise<number> {
  const prepared = prepareInboundPage(changes, knownTables)
  if (Object.keys(prepared).length === 0) return 0

  updateDates(prepared)
  await database.write(async () => {
    await applyRemoteChanges(prepared, { db: database, sendCreatedAsUpdated: true })
  })

  return countRecordsInChanges(prepared)
}

/**
 * Only `sync_hub` changes which entities the server returns; the rest are
 * equivalent, so the real platform goes out purely for the audit trail.
 */
const devicePeerType = (): string => (Platform.OS === "ios" ? "ios" : "android")

/**
 * Run a request, re-authenticating once if the token expired. A backfill can run
 * for ten minutes and outlive its token.
 */
async function withAuthRefresh<T>(
  call: () => Promise<RpcResult<T>>,
  refresh: () => Promise<boolean>,
): Promise<RpcResult<T>> {
  const first = await call()
  if (first.ok) return first
  if (first.error.code !== "AUTH_FAILED") return first
  if (!(await refresh())) return first
  return call()
}

/**
 * Push everything pending, then backfill from `since`.
 *
 * Holds the process-wide sync lock for the whole run, so ordinary sync queues
 * behind it rather than interleaving. Returns the outcome instead of throwing;
 * `resumable` says whether a retry would continue from the stored cursor.
 */
export async function runManualSync(args: {
  peerId: string
  since: number
  signal: AbortSignal
  onProgress: (p: ManualSyncProgress) => void
}): Promise<ManualSyncResult> {
  const { peerId, since, signal, onProgress } = args

  // Outside `withSyncLock` — the lock is not reentrant and this must not be
  // held across the repair. See `repairSchemaDrift`.
  await databaseReady

  // Brackets the shared store from inside the lock so consumers do not read
  // "idle" through a ten-minute operation. Inside matters: bracketing from the
  // caller would let the lock release first, so a queued ordinary sync could set
  // FETCHING before the reset lands and the store would read IDLE all run.
  return withSyncLock("manual", async () => {
    syncStore.trigger.start_sync()
    try {
      return await runLocked()
    } finally {
      syncStore.trigger.force_reset()
    }
  })

  async function runLocked(): Promise<ManualSyncResult> {
    const peer = await Peer.DB.getById(peerId)
    if (peer.status !== "active") {
      return { ok: false as const, error: "This server is not active", resumable: false }
    }
    // This transport speaks tRPC; a hub speaks its own protocol at the same
    // paths, so pointing it at one gives confusing 404s rather than a refusal.
    if (peer.peerType !== "cloud_server") {
      return { ok: false as const, error: "Manual sync requires a cloud server", resumable: false }
    }
    const baseUrl = Peer.getUrl(peer)
    if (!baseUrl) {
      return { ok: false as const, error: "This server has no address", resumable: false }
    }

    const transport = createTrpcCloudTransport(baseUrl, getBearerToken)
    const refresh = () => refreshBearerToken(transport)
    const peerType = devicePeerType()
    const knownTables = new Set(Object.keys(database.schema.tables))

    // A device that has never held a token would otherwise discover that on its
    // first request, in the operation least able to afford one.
    if ((await getBearerToken()) === "") {
      await refresh()
    }

    const pageBytes = await pickPageBudget()

    let recordsPushed = 0
    // Accumulated across chunks. SyncRejectedIds is keyed by known table names,
    // too narrow to build up one table at a time.
    const rejected: Record<string, string[]> = {}
    const rejectedCount = () => Object.values(rejected).flat().length

    const report = (phase: ManualSyncProgress["phase"], p: Partial<ManualSyncProgress> = {}) =>
      onProgress({
        phase,
        table: "",
        pagesApplied: 0,
        recordsApplied: 0,
        tablesRemaining: 0,
        ...p,
        recordsPushed,
        rejectedCount: rejectedCount(),
      })

    report("pushing")

    const local = await fetchLocalChanges(database)

    for (const chunk of chunkLocalChanges(local, PUSH_CHUNK_RECORDS)) {
      if (signal.aborted) {
        return { ok: false as const, error: "Cancelled", resumable: true }
      }

      const pushResult = await withAuthRefresh(
        () =>
          withRetry(
            () =>
              transport.sendCommand<{
                accepted: number
                rejected: Record<string, string[]>
                by_table: Record<string, { accepted: number; rejected: number }>
              }>("sync.backfillPush", {
                changes: chunk.changes,
                since,
                peer_type: peerType,
              }),
            signal,
          ),
        refresh,
      )

      if (!pushResult.ok) {
        return { ok: false as const, error: pushResult.error.message, resumable: true }
      }

      const chunkRejected = pushResult.data.rejected ?? {}
      for (const [table, ids] of Object.entries(chunkRejected)) {
        rejected[table] = [...(rejected[table] ?? []), ...ids]
      }

      // Rejected rows keep their `_status`/`_changed` and rejected deletions
      // keep their tombstone, so a later pull cannot silently overwrite them.
      // Marking per chunk is what lets an interrupted push keep its progress.
      await markLocalChangesAsSynced(database, chunk, chunkRejected as SyncRejectedIds)

      // What the server took, not what was offered — a rejected row is still
      // pending afterwards.
      const offered = countRecordsInChanges(chunk.changes)
      const refused = Object.values(chunkRejected).flat().length
      recordsPushed += Math.max(0, offered - refused)
      report("pushing")
    }

    const resume = await Peer.DB.getResumeState(peerId)
    const startCursor = resume && resume.since === since ? resume.cursor : null

    const pull = await pullLoop({
      since,
      startCursor,
      signal,
      fetchPage: ({ since: from, cursor }) =>
        withAuthRefresh(
          () =>
            withRetry(
              () =>
                transport.sendQuery<PullPage>("sync.backfillPull", {
                  since: from,
                  cursor,
                  page_bytes: pageBytes,
                  page_rows: PULL_PAGE_ROWS,
                  peer_type: peerType,
                }),
              signal,
            ),
          refresh,
        ),
      apply: (changes) => applyPage(changes, knownTables),
      saveResume: (state) => Peer.DB.saveResumeState(peerId, state),
      onProgress: (p) =>
        report("pulling", {
          table: p.table,
          pagesApplied: p.pagesApplied,
          recordsApplied: p.recordsApplied,
          tablesRemaining: p.tablesRemaining,
        }),
    })

    if (!pull.ok) {
      // A cursor encodes an entity list, so a redeploy or schema change can
      // invalidate it permanently. Keeping such a cursor would make every later
      // run against the same range fail identically forever.
      if (!pull.resumable) await Peer.DB.clearResumeState(peerId)
      return { ok: false as const, error: pull.error, resumable: pull.resumable }
    }

    // Both values are ordinary sync's `since`, so having pulled [since,
    // snapshotTs] this device is complete to snapshotTs only if `since` reaches
    // back to where it was already complete. A bounded range starting after that
    // leaves a gap, and moving the watermark past it hides the gap forever.
    //
    // Each watermark is guarded against ITS OWN prior value: `last_synced_at`
    // holds the client clock (`Date.now()` in peerSync) while
    // `__watermelon_last_pulled_at` holds the server's. Comparing against the
    // wrong one lets clock skew wave a bounded range past the guard.
    if (pull.snapshotTs !== null) {
      const priorPeer = peer.lastSyncedAt ?? 0
      if (since <= priorPeer) {
        await Peer.DB.updateLastSyncedAt(peerId, pull.snapshotTs)
      }
      const priorPulled = (await getLastPulledAt(database)) ?? 0
      if (since <= priorPulled) {
        await setLastPulledAt(database, pull.snapshotTs)
      }
    }
    await Peer.DB.clearResumeState(peerId)

    // The run's real totals — a "done" that reset these to zero would leave the
    // completion screen reporting nothing was transferred.
    report("done", { recordsApplied: pull.recordsApplied, pagesApplied: pull.pagesApplied })

    return {
      ok: true as const,
      recordsPushed,
      recordsApplied: pull.recordsApplied,
      rejected,
    }
  }
}
