import { isIP } from "node:net";
import { sql } from "kysely";
import db from "@/db";
import EventLog from "@/models/event-logs";
import { Logger } from "@hikmahealth/js-utils";

export type SyncAuditArgs = {
  /** "manual_sync" for the backfill operations, "sync" for everything else. */
  feature: "sync" | "manual_sync";
  /** A user id, `device:<id>` for a hub caller, or "unauthenticated". */
  userId: string;
  direction: "pull" | "push";
  peerType: string;
  since: number;
  /** The watermark handed back to the client. A push has none. */
  snapshotTs?: number;
  /** When the server began handling the request, in epoch ms. */
  startedAt: number;
  counts: Record<string, number>;
  /** Per-table accepted/rejected tallies; only a push has them. */
  byTable?: Record<string, { accepted: number; rejected: number }>;
  outcome: "started" | "completed" | "failed";
  error?: string;
  /** Kept in metadata; anything that is not a valid IP is dropped. */
  ipAddress?: string | null;
};

// The shared db is typed from the codegen'd schema, while logEvent declares its
// own event_logs shape. Kysely's generic is invariant, so the structurally
// equivalent types need a cast at the boundary.
type EventLogDatabase = Parameters<typeof EventLog.logEvent>[0];

/**
 * Record one sync request in the audit log (§164.312(b)). Never throws: a
 * failed audit write must not fail the sync itself.
 *
 * - `finished_at` is set only when the operation completed.
 * - The IP goes in metadata, not `ip_address`: `inet::text` adds a netmask
 *   (`1.2.3.4/32`), so the hash verification job would never match.
 * - `changes` stays `{}`: the verification job hashes its jsonb rendering,
 *   which re-spaces anything non-empty.
 */
export async function recordSyncAudit(args: SyncAuditArgs): Promise<void> {
  try {
    const ipAddress =
      args.ipAddress && isIP(args.ipAddress) ? args.ipAddress : null;

    await EventLog.logEvent(
      db as unknown as EventLogDatabase,
      {
        actionType: "EXPORT",
        tableName: "*",
        rowId: "*",
        changes: {},
        userId: args.userId,
        metadata: {
          feature: args.feature,
          direction: args.direction,
          peer_type: args.peerType,
          since: args.since,
          ...(args.snapshotTs !== undefined
            ? { snapshot_ts: args.snapshotTs }
            : {}),
          started_at: args.startedAt,
          ...(args.outcome === "completed" ? { finished_at: Date.now() } : {}),
          counts: args.counts,
          ...(args.byTable ? { by_table: args.byTable } : {}),
          outcome: args.outcome,
          ...(args.error ? { error: args.error } : {}),
          ...(ipAddress ? { ip_address: ipAddress } : {}),
        },
      },
      {
        ipAddress: null,
        deviceId: args.peerType,
        appId: args.feature,
      },
    );
  } catch (error) {
    Logger.error({ msg: "[sync-audit] failed to record sync", error });
  }
}

/** Total rows per table in a pull's change set. */
export function countChanges(
  changes: Record<
    string,
    { created: unknown[]; updated: unknown[]; deleted: unknown[] }
  >,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, entry] of Object.entries(changes)) {
    counts[table] =
      entry.created.length + entry.updated.length + entry.deleted.length;
  }
  return counts;
}

/** Accepted rows per table in a push's outcome. */
export function acceptedCounts(
  byTable: Record<string, { accepted: number; rejected: number }>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, tally] of Object.entries(byTable)) {
    counts[table] = tally.accepted;
  }
  return counts;
}

export const SYNC_EVENTS_PAGE_SIZE = 100;

/** One sync as a user sees it: a pull, plus its push if there was one. */
export type SyncEvent = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  kind: "sync" | "manual_sync";
  outcome: "completed" | "failed" | "started";
  startedAt: number;
  finishedAt: number | null;
  recordsReceived: number;
  recordsSent: number;
  recordsRejected: number;
  peerType: string;
  ipAddress: string | null;
  error: string | null;
};

export type SyncEventRow = {
  id: string;
  created_at: Date;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  metadata: Record<string, unknown>;
  push_metadata: Record<string, unknown> | null;
};

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const sumNumbers = (values: unknown[]): number =>
  values.reduce<number>(
    (total, value) => total + (typeof value === "number" ? value : 0),
    0,
  );

const totalCount = (counts: unknown): number =>
  typeof counts === "object" && counts !== null
    ? sumNumbers(Object.values(counts))
    : 0;

const totalRejected = (byTable: unknown): number =>
  typeof byTable === "object" && byTable !== null
    ? sumNumbers(
        Object.values(byTable).map((tally) =>
          typeof tally === "object" && tally !== null
            ? (tally as { rejected?: unknown }).rejected
            : 0,
        ),
      )
    : 0;

const outcomeOf = (metadata: Record<string, unknown>): SyncEvent["outcome"] => {
  const outcome = metadata.outcome;
  if (outcome === "completed") return "completed";
  if (outcome === "started") return "started";
  return "failed";
};

/** Fold a recorded row, and the push matched to it if any, into one event. */
export const toSyncEvent = (row: SyncEventRow): SyncEvent => {
  const { metadata, push_metadata: push } = row;
  const isPush = metadata.direction === "push";
  const outcomes = [outcomeOf(metadata), ...(push ? [outcomeOf(push)] : [])];
  const outcome = outcomes.includes("failed")
    ? "failed"
    : outcomes.includes("started")
      ? "started"
      : "completed";
  const last = push ?? metadata;

  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    kind: metadata.feature === "manual_sync" ? "manual_sync" : "sync",
    outcome,
    startedAt: numberOrNull(metadata.started_at) ?? row.created_at.getTime(),
    finishedAt: outcome === "completed" ? numberOrNull(last.finished_at) : null,
    recordsReceived: isPush ? 0 : totalCount(metadata.counts),
    recordsSent: isPush
      ? totalCount(metadata.counts)
      : push
        ? totalCount(push.counts)
        : 0,
    recordsRejected: totalRejected((isPush ? metadata : push)?.by_table),
    peerType: stringOrNull(metadata.peer_type) ?? "unknown",
    ipAddress: stringOrNull(metadata.ip_address),
    error: stringOrNull(metadata.error) ?? stringOrNull(push?.error),
  };
};

type Alias = "entry" | "pull" | "push" | "later";

const isOrdinary = (alias: Alias, direction: "pull" | "push") =>
  sql.raw(
    `${alias}.table_name = '*' AND ${alias}.metadata->>'feature' = 'sync' ` +
      `AND ${alias}.metadata->>'direction' = '${direction}'`,
  );

/**
 * Whether `push` belongs to the sync `pull` started. Mobile pushes with the
 * timestamp its pull returned, which is exact even on shared accounts. A hub
 * pushes with its pull's watermark, so it pairs with its own latest pull.
 */
const pushBelongsToPull = (pull: Alias, push: Alias) =>
  sql.raw(`
    ${push}.user_id = ${pull}.user_id
    AND ${pull}.created_at <= ${push}.created_at
    AND ${pull}.created_at > ${push}.created_at - interval '1 hour'
    AND (
      ${push}.metadata->>'since' = ${pull}.metadata->>'snapshot_ts'
      OR (
        ${push}.metadata->>'peer_type' = 'sync_hub'
        AND ${push}.metadata->>'since' = ${pull}.metadata->>'since'
        AND NOT EXISTS (
          SELECT 1 FROM event_logs later
          WHERE later.table_name = '*'
            AND later.metadata->>'feature' = 'sync'
            AND later.metadata->>'direction' = 'pull'
            AND later.user_id = ${pull}.user_id
            AND later.created_at > ${pull}.created_at
            AND later.created_at <= ${push}.created_at
        )
      )
    )
  `);

/**
 * One page of sync events, newest first. Fetches one extra row to detect a
 * next page instead of counting a table that only grows.
 */
export async function listSyncEvents(options: {
  page: number;
  userId?: string;
}): Promise<{ events: SyncEvent[]; hasNextPage: boolean }> {
  const page = Math.max(1, Math.floor(options.page));
  const offset = (page - 1) * SYNC_EVENTS_PAGE_SIZE;
  const userFilter = options.userId
    ? sql`AND entry.user_id = ${options.userId}`
    : sql``;

  const result = await sql<SyncEventRow>`
    SELECT entry.id, entry.created_at, entry.user_id,
           users.name AS user_name, users.email AS user_email,
           entry.metadata, matched.metadata AS push_metadata
    FROM event_logs entry
    LEFT JOIN users ON users.id::text = entry.user_id
    LEFT JOIN LATERAL (
      SELECT push.metadata FROM event_logs push
      WHERE ${isOrdinary("entry", "pull")}
        AND ${isOrdinary("push", "push")}
        AND ${pushBelongsToPull("entry", "push")}
      ORDER BY push.created_at
      LIMIT 1
    ) matched ON true
    WHERE entry.table_name = '*'
      AND entry.metadata->>'feature' IN ('sync', 'manual_sync')
      ${userFilter}
      AND NOT (
        ${isOrdinary("entry", "push")}
        AND EXISTS (
          SELECT 1 FROM event_logs pull
          WHERE ${isOrdinary("pull", "pull")}
            AND ${pushBelongsToPull("pull", "entry")}
        )
      )
    ORDER BY entry.created_at DESC
    LIMIT ${SYNC_EVENTS_PAGE_SIZE + 1} OFFSET ${offset}
  `.execute(db);

  return {
    events: result.rows.slice(0, SYNC_EVENTS_PAGE_SIZE).map(toSyncEvent),
    hasNextPage: result.rows.length > SYNC_EVENTS_PAGE_SIZE,
  };
}
