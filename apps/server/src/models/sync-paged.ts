import { TRPCError } from "@trpc/server";
import { sql } from "kysely";
import db from "@/db";
import type Device from "./device";
import type { RequestCaller } from "@/types";
import {
  resolveEntitiesForPeer,
  applyClinicScope,
  FULL_SNAPSHOT_TABLES,
  syncSelection,
  normalizeCivilDates,
  type SyncEntity,
} from "./sync-shared";

export type Bucket = "created" | "updated" | "deleted";

const BUCKETS: readonly Bucket[] = ["created", "updated", "deleted"];

/**
 * Resume position for a paged pull.
 *
 * `since` is the client's requested lower bound; `ts` is the snapshot upper
 * bound captured on page 1 and carried unchanged through the whole run, so the
 * pull is a consistent view even though it spans many requests.
 * `t` indexes into the peer's entity list, `b` names the bucket within that
 * entity, and `k` is the keyset position — [sort column value, id] — or null
 * at the start of a bucket.
 *
 * `n` is the running row tally by delivery name. It rides in the cursor because
 * the server holds no state between pages, and an audit row that reported only
 * the final page would read as "almost nothing moved" after a million-row
 * backfill. Like every other field here it is client-modifiable, and like every
 * other field it is validated on the way back in.
 */
export type PageCursor = {
  v: 1;
  since: number;
  ts: number;
  t: number;
  b: Bucket;
  k: [string, string] | null;
  n: Record<string, number>;
};

export function encodeCursor(c: PageCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64");
}

const bad = (message: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message });
};

/**
 * Decode and fully validate a client-supplied cursor.
 *
 * Every field is attacker-controlled. `t` and `b` in particular select a table
 * and a column for the query builder, so they are validated against the
 * server's own entity list and bucket names rather than used as given.
 */
export function decodeCursor(raw: string, entityCount: number): PageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return bad("Malformed sync cursor");
  }

  if (typeof parsed !== "object" || parsed === null) {
    return bad("Malformed sync cursor");
  }
  const c = parsed as Record<string, unknown>;

  if (c.v !== 1) return bad(`Unsupported sync cursor version: ${String(c.v)}`);

  if (typeof c.since !== "number" || !Number.isFinite(c.since) || c.since < 0) {
    return bad("Invalid sync cursor timestamp: since");
  }
  if (typeof c.ts !== "number" || !Number.isFinite(c.ts) || c.ts < 0) {
    return bad("Invalid sync cursor timestamp: ts");
  }

  if (
    typeof c.t !== "number" ||
    !Number.isInteger(c.t) ||
    c.t < 0 ||
    c.t >= entityCount
  ) {
    return bad("Invalid sync cursor table index");
  }

  if (typeof c.b !== "string" || !BUCKETS.includes(c.b as Bucket)) {
    return bad("Invalid sync cursor bucket");
  }

  if (c.k !== null) {
    if (
      !Array.isArray(c.k) ||
      c.k.length !== 2 ||
      typeof c.k[0] !== "string" ||
      typeof c.k[1] !== "string"
    ) {
      return bad("Invalid sync cursor key");
    }
  }

  return {
    v: 1,
    since: c.since,
    ts: c.ts,
    t: c.t,
    b: c.b as Bucket,
    k: c.k as [string, string] | null,
    n: decodeTally(c.n),
  };
}

/**
 * Validate the running row tally.
 *
 * Absent means a cursor issued before the tally existed; that reads as empty
 * rather than as an error, so a run in flight across a deploy keeps working.
 * Keys are not checked here — only `getDeltaPage` knows which tables the peer
 * actually syncs, and it drops the rest.
 */
function decodeTally(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return bad("Invalid sync cursor tally");
  }

  const tally: Record<string, number> = {};
  for (const [table, count] of Object.entries(raw)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return bad(`Invalid sync cursor tally for ${table}`);
    }
    tally[table] = count;
  }
  return tally;
}

export const SORT_COLUMN: Record<Bucket, string> = {
  created: "server_created_at",
  updated: "last_modified",
  deleted: "deleted_at",
};

/** Hard server-side ceilings. A client asking for more gets these. */
export const MAX_PAGE_BYTES = 12_000_000;
export const MAX_PAGE_ROWS = 2_000;
export const DEFAULT_PAGE_ROWS = 500;

/**
 * Column alias carrying the sort value at full precision.
 *
 * Postgres stores `timestamptz` to the microsecond, but node-postgres hands it
 * back as a JS Date, which holds only milliseconds. A cursor built from that
 * Date names an instant *earlier* than the row it came from, so the keyset
 * comparison `sort > cursor` matches that same row again and the pull never
 * advances past it — an infinite loop, not a lost row.
 *
 * So the sort value is also selected as microsecond-precision text and the
 * cursor is built from that. Stripped from every row before it reaches the
 * client.
 */
export const SORT_KEY_ALIAS = "__sync_sort_key";

/**
 * Render a sort-column value for the cursor.
 *
 * Prefers the full-precision text alias. The Date branch is the fallback for
 * callers that did not select it, and truncates to milliseconds — correct only
 * where the stored value has no sub-millisecond component. `String(date)` would
 * yield "Thu Jan 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)", which
 * is not a `timestamptz` literal at all, so ISO-8601 is the floor.
 */
const sortValueToCursor = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const cursorKeyOf = (
  row: Record<string, any>,
  bucket: Bucket,
): [string, string] => [
  row[SORT_KEY_ALIAS] != null
    ? String(row[SORT_KEY_ALIAS])
    : sortValueToCursor(row[SORT_COLUMN[bucket]]),
  String(row.id),
];

/**
 * Take rows from a fetched batch until either budget is spent.
 *
 * Byte budget is checked before row count because row count alone does not
 * bound memory — events.form_data varies by orders of magnitude, so 500 rows
 * may be 200 KB or 200 MB.
 *
 * At least one row is always taken. A single row larger than the entire budget
 * would otherwise return an empty page forever and the pull would never
 * terminate.
 *
 * `exhausted` means the caller's batch was fully consumed, so the caller can
 * distinguish "bucket finished" from "page filled up".
 */
export function assemblePage(
  rows: Record<string, any>[],
  bucket: Bucket,
  pageBytes: number,
  pageRows: number,
): {
  taken: Record<string, any>[];
  lastKey: [string, string] | null;
  exhausted: boolean;
} {
  const taken: Record<string, any>[] = [];
  let bytes = 0;

  for (const row of rows) {
    if (taken.length >= pageRows) break;
    const size = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (taken.length > 0 && bytes + size > pageBytes) break;
    taken.push(row);
    bytes += size;
  }

  const last = taken[taken.length - 1];
  const lastKey: [string, string] | null = last
    ? cursorKeyOf(last, bucket)
    : null;

  return { taken, lastKey, exhausted: taken.length === rows.length };
}

export type DeltaPage = {
  changes: Record<
    string,
    { created: any[]; updated: any[]; deleted: string[] }
  >;
  nextCursor: string | null;
  timestamp: number;
  progress: { table: string; bucket: Bucket; tablesRemaining: number };
  /** Rows delivered by the whole run so far, by delivery name. */
  totals: Record<string, number>;
};

const NEXT_BUCKET: Record<Bucket, Bucket | null> = {
  created: "updated",
  updated: "deleted",
  deleted: null,
};

/**
 * Tables the ordinary pull delivers outside the entity lists.
 *
 * `getDeltaRecords` appends these two after its entity loop, and the paged pull
 * has to as well. Omitting them is not a smaller delivery but a permanent one:
 * a completed run advances the client's watermark to its snapshot, so anything
 * inside [since, snapshot] left out here is never asked for again by ordinary
 * sync either. For `user_clinic_permissions` that means a device silently loses
 * clinic access — worst on a first sync, which arrives with `since = 0` and
 * would leave the device with no permission rows at all.
 *
 * They cannot ride the three-bucket keyset walk: neither carries
 * `server_created_at`, `last_modified`, `is_deleted` or `deleted_at`, which is
 * every column `fetchBucket` filters and sorts on.
 *
 * So they are delivered whole on the final page, as the ordinary pull already
 * does — bounded in practice, since `app_config` is tens of rows and
 * `user_clinic_permissions` one narrow row per user per clinic. The final page
 * can therefore exceed `page_bytes` by their size, the same kind of overshoot
 * the cross-table walk already permits.
 *
 * `deleted` is always empty: neither table soft-deletes.
 */
const AUX_TABLES = [
  { table: "user_clinic_permissions", createdCol: "created_at", updatedCol: "updated_at" },
  { table: "app_config", createdCol: "created_at", updatedCol: "updated_at" },
] as const;

/** Delivery names of the auxiliary tables, for tally filtering. */
export const AUX_DELIVERY_NAMES: readonly string[] = AUX_TABLES.map(
  (a) => a.table,
);

/**
 * Fetch the auxiliary tables whole.
 *
 * Predicates mirror `getDeltaRecords` exactly — created is `created_at >=
 * since`, updated is `created_at < since AND updated_at > since` — with one
 * addition: both are also bounded above by the run's snapshot. The ordinary
 * pull has no upper bound because it takes its own timestamp at the moment it
 * runs; a paged run must use the snapshot its client will adopt as a watermark,
 * or rows written mid-run would be delivered and then re-requested.
 */
async function fetchAuxTables(args: {
  since: number;
  ts: number;
  clinicIds: string[] | null;
}): Promise<{ changes: DeltaPage["changes"]; counts: Record<string, number> }> {
  const { since, ts, clinicIds } = args;
  const from = new Date(since);
  const upper = new Date(ts);

  const changes: DeltaPage["changes"] = {};
  const counts: Record<string, number> = {};

  for (const { table, createdCol, updatedCol } of AUX_TABLES) {
    // `applyClinicScope` filters user_clinic_permissions by its clinic_id and
    // leaves app_config untouched, as the ordinary pull does. app_config now has
    // a `clinic_ids` column but is deliberately absent from
    // `CLINIC_ARRAY_TABLES`: its semantics invert event_forms' (null = all
    // clinics, [] = none), so that jsonb branch would read "scoped to no clinic"
    // as "global". Devices scope these rows on read instead.
    const created = (await applyClinicScope(
      db
        .selectFrom(table as any)
        .selectAll()
        .where(createdCol as any, ">=", from)
        .where(createdCol as any, "<=", upper),
      table,
      clinicIds,
    ).execute()) as Record<string, any>[];

    const updated = (await applyClinicScope(
      db
        .selectFrom(table as any)
        .selectAll()
        .where(createdCol as any, "<", from)
        .where(updatedCol as any, ">", from)
        .where(updatedCol as any, "<=", upper),
      table,
      clinicIds,
    ).execute()) as Record<string, any>[];

    if (created.length === 0 && updated.length === 0) continue;

    changes[table] = {
      created: normalizeCivilDates(table, created),
      updated: normalizeCivilDates(table, updated),
      deleted: [],
    };
    counts[table] = created.length + updated.length;
  }

  return { changes, counts };
}

/**
 * The key an entity's changeset is delivered under.
 *
 * `Device.Table` declares no `mobileName` and is reachable through the hub
 * entity list, so falling back to the server name keeps it out of the
 * `changes["undefined"]` bucket it would otherwise land in.
 */
const deliveryName = (entity: SyncEntity): string =>
  entity.Table.mobileName ?? entity.Table.name;

/** One keyset query for a single entity/bucket. */
async function fetchBucket(args: {
  entity: SyncEntity;
  bucket: Bucket;
  since: number;
  ts: number;
  key: [string, string] | null;
  limit: number;
  clinicIds: string[] | null;
  peerType: Device.DeviceTypeT;
}): Promise<Record<string, any>[]> {
  const { entity, bucket, since, ts, key, limit, clinicIds, peerType } = args;
  const table = entity.Table.name;
  const sortCol = SORT_COLUMN[bucket];
  // MAX_HISTORY_DAYS_SYNC is deliberately not applied here — see getDeltaPage.
  const from = new Date(since);
  const upper = new Date(ts);

  /**
   * A snapshot table ignores `since`: live rows ride `created` and tombstones
   * ride `deleted`, leaving `updated` nothing to carry. Splitting across created
   * and updated would double up, since without a lower bound a row modified
   * after creation satisfies both predicates.
   *
   * `created`, not the ordinary pull's `updated`: mobile applies these pages
   * with `sendCreatedAsUpdated: true` (cloudManualSync.ts), which is what
   * suppresses the per-record logError for rows the device already holds.
   */
  const isSnapshot = FULL_SNAPSHOT_TABLES.has(table);
  if (isSnapshot && bucket === "updated") return [];

  // The deleted bucket selects only (id, deleted_at) — a tombstone needs no
  // payload, and selecting all columns would blow the byte budget for nothing.
  // Build it separately rather than calling selectAll() then select().
  let q: any;

  // Mirrors getDeltaRecords: mobile gets the projected columns, a hub the row.
  const selection = syncSelection(table, peerType);
  const selectPayload = (query: any) =>
    selection ? query.select(selection) : query.selectAll();

  if (bucket === "created") {
    q = selectPayload(db.selectFrom(table as any))
      .where("server_created_at", "<=", upper)
      .where("deleted_at", "is", null);
    if (isSnapshot) {
      // Null-safe, matching `getFullSnapshot`: `is_deleted` is nullable, and
      // `= false` skips NULL, which would put such a row in neither list. Delta
      // tables keep `= false`, long-standing behaviour left alone here.
      q = q.where("is_deleted", "is not", true);
    } else {
      q = q
        .where("is_deleted", "=", false)
        .where("server_created_at", ">=", from);
    }
  } else if (bucket === "updated") {
    q = selectPayload(db.selectFrom(table as any))
      .where("last_modified", ">", from)
      .where("last_modified", "<=", upper)
      .where("server_created_at", "<", from)
      .where("deleted_at", "is", null)
      .where("is_deleted", "=", false);
  } else {
    // Unlike getDeltaRecords, no `since === 0` skip. There 0 means a fresh
    // device with nothing to delete; here both callers pass 0 from devices that
    // may already hold records — the manual "everything" run by definition, and
    // first sync whenever `last_pulled_at` is unset on a device already
    // populated from a hub. Skipping tombstones strands every prior deletion
    // permanently, because the completed run moves the watermark past them.
    q = db
      .selectFrom(table as any)
      .select(["id", "deleted_at"] as any)
      .where("deleted_at", "<=", upper);
    if (isSnapshot) {
      // Every tombstone, not just those since `from`, and keyed on `deleted_at`
      // alone — `getFullSnapshot` treats either marker as removal.
      //
      // It does catch one shape this cannot: `is_deleted` set with no
      // `deleted_at`. That is the keyset's sort column, and a NULL has no cursor
      // position. Ordinary delta sync misses it for the same reason, so it is a
      // pre-existing data defect, not a gap introduced here.
      q = q.where("deleted_at", "is not", null);
    } else {
      q = q.where("deleted_at", ">", from).where("is_deleted", "=", true);
    }
  }

  // The sort value again, as microsecond-precision text. See SORT_KEY_ALIAS —
  // the Date the driver returns is millisecond-truncated and cannot express a
  // cursor that reliably excludes the row it was built from.
  q = q.select(
    sql`to_char(${sql.ref(sortCol)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
      SORT_KEY_ALIAS,
    ),
  );

  // Keyset: strictly after the last row of the previous page, by (sort, id).
  // A row-value comparison rather than `sort > x OR (sort = x AND id > y)`, so
  // the planner uses the composite index as an Index Cond instead of a Filter.
  // Both operands are cast explicitly: the parameters arrive as untyped text and
  // `id` is a uuid column, so otherwise Postgres has no common type.
  if (key) {
    q = q.where(
      sql`(${sql.ref(sortCol)}, ${sql.ref("id")}) > (${key[0]}::timestamptz, ${key[1]}::uuid)` as any,
    );
  }

  q = applyClinicScope(q, table, clinicIds)
    .orderBy(sortCol)
    .orderBy("id")
    .limit(limit);

  // Ahead of `assemblePage`, so the byte budget measures what is actually sent.
  // A civil date left as a Date reaches the client through superjson still typed
  // as one, and mobile's `updateDates` reads it with getUTC* getters — a day
  // early on any server east of UTC.
  return normalizeCivilDates(table, (await q.execute()) as Record<string, any>[]);
}

/**
 * Fetch one page of the delta, resuming from `cursor`.
 *
 * Iteration order is (entity index, bucket, keyset position). Entities keep the
 * dependency order of the shared entity list — patients before visits before
 * events — so a partially applied backfill never leaves a child without its
 * parent.
 *
 * The snapshot `ts` is captured on the first page and carried through every
 * later page, with each query upper-bounded by it. Rows written mid-backfill
 * therefore cannot shift pages; they are picked up by the client's next sync,
 * whose cursor is this `ts`.
 *
 * `since` is honoured verbatim. Unlike `getDeltaRecords`, this does not raise
 * the lower bound to MAX_HISTORY_DAYS_SYNC: that limit bounds the history
 * routine sync keeps pushing at a device, while this is the recovery path whose
 * purpose is to fetch that history back. Routine sync must not route through
 * here.
 *
 * Restoring the clamp would not narrow a run but empty it — both non-deleted
 * buckets share one lower bound, so a record older than the cutoff and
 * untouched since matches neither, and the completed run then moves the
 * client's watermark past the gap.
 */
export async function getDeltaPage(args: {
  since: number;
  cursor: string | null;
  pageBytes: number;
  pageRows: number;
  peerType: Device.DeviceTypeT;
  caller: RequestCaller;
}): Promise<DeltaPage> {
  const { since, cursor, peerType, caller } = args;
  const entities = resolveEntitiesForPeer(peerType, "push");

  const pageBytes = Math.min(Math.max(1, args.pageBytes), MAX_PAGE_BYTES);
  const pageRows = Math.min(Math.max(1, args.pageRows), MAX_PAGE_ROWS);

  const clinicIds: string[] | null =
    peerType === "sync_hub" && "device" in caller
      ? ((caller.device.clinic_ids as unknown as string[]) ?? null)
      : null;

  const pos: PageCursor = cursor
    ? decodeCursor(cursor, entities.length)
    : { v: 1, since, ts: Date.now(), t: 0, b: "created", k: null, n: {} };

  // A client may not change `since` mid-run: the snapshot and the lower bound
  // must stay consistent for the whole pull.
  if (cursor && pos.since !== since) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "since must not change while a paged pull is in progress",
    });
  }

  const changes: DeltaPage["changes"] = {};
  let t = pos.t;
  let bucket: Bucket = pos.b;
  let key = pos.k;

  // The tally comes back through the client, so only tables this peer actually
  // syncs survive. Anything else it invented is dropped rather than carried
  // into the audit record written at the end of the run.
  const deliverable = new Set([
    ...entities.map(deliveryName),
    ...AUX_DELIVERY_NAMES,
  ]);
  const totals: Record<string, number> = {};
  for (const [table, count] of Object.entries(pos.n)) {
    if (deliverable.has(table)) totals[table] = count;
  }

  // Walk forward until the page is full or the entity list is exhausted.
  // Empty buckets are skipped without returning to the client, so a run does
  // not burn a round trip per empty table.
  while (t < entities.length) {
    const entity = entities[t];
    const mobileName = deliveryName(entity);

    // Fetch one more than the page allows: if the probe row comes back, rows
    // remain in this bucket even when the page was not otherwise full.
    const probed = await fetchBucket({
      entity,
      bucket,
      since,
      ts: pos.ts,
      key,
      limit: pageRows + 1,
      clinicIds,
      peerType,
    });
    const hasMoreBeyondPage = probed.length > pageRows;
    const candidates = probed.slice(0, pageRows);

    const { taken, lastKey, exhausted } = assemblePage(
      candidates,
      bucket,
      pageBytes,
      pageRows,
    );

    // More remains if the byte budget cut the page short, or if the probe fired.
    const moreInBucket = !exhausted || hasMoreBeyondPage;

    if (taken.length > 0) {
      totals[mobileName] = (totals[mobileName] ?? 0) + taken.length;
      changes[mobileName] ??= { created: [], updated: [], deleted: [] };
      if (bucket === "deleted") {
        changes[mobileName].deleted.push(...taken.map((r) => String(r.id)));
      } else {
        // The cursor helper column is server bookkeeping; it is not part of any
        // table's schema and would be rejected on the way into the client.
        for (const r of taken) delete r[SORT_KEY_ALIAS];
        changes[mobileName][bucket].push(...taken);
      }
    }

    if (moreInBucket) {
      return {
        changes,
        nextCursor: encodeCursor({ ...pos, t, b: bucket, k: lastKey, n: totals }),
        timestamp: pos.ts,
        progress: {
          table: mobileName,
          bucket,
          tablesRemaining: entities.length - t,
        },
        totals,
      };
    }

    const next = NEXT_BUCKET[bucket];
    if (next) {
      bucket = next;
      key = null;
    } else {
      t += 1;
      bucket = "created";
      key = null;
    }
  }

  // The entity walk is done, so this is the last page — the only one that may
  // carry the unpaged auxiliary tables. Any earlier page would repeat them once
  // per page. See AUX_TABLES.
  const aux = await fetchAuxTables({ since, ts: pos.ts, clinicIds });
  for (const [table, bucket] of Object.entries(aux.changes)) {
    changes[table] = bucket;
  }
  for (const [table, count] of Object.entries(aux.counts)) {
    totals[table] = (totals[table] ?? 0) + count;
  }

  return {
    changes,
    nextCursor: null,
    timestamp: pos.ts,
    progress: {
      table: entities[entities.length - 1]
        ? deliveryName(entities[entities.length - 1])
        : "",
      bucket: "deleted",
      tablesRemaining: 0,
    },
    totals,
  };
}
