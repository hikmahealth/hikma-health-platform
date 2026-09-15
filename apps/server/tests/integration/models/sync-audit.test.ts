import { describe, it, expect, vi, beforeAll } from "vitest";
import { sql } from "kysely";
import { v1 as uuidV1 } from "uuid";
import { testDb } from "../setup";

vi.mock("@/db", () => ({ default: testDb }));

import { listSyncEvents, recordSyncAudit } from "@/models/sync-audit";

// event_logs is append-only — a BEFORE DELETE trigger raises on any delete — so
// these rows outlive the run by design. Each test uses its own user id so it
// only ever sees its own row.
const userId = uuidV1();

const args = {
  feature: "manual_sync" as const,
  userId,
  direction: "pull" as const,
  peerType: "android",
  since: 1_700_000_000_000,
  snapshotTs: 1_800_000_000_000,
  startedAt: 1_800_000_000_000,
  counts: { patients: 12, events: 3 },
  outcome: "completed" as const,
};

const rowsForUser = async (id: string) =>
  await testDb
    .selectFrom("event_logs")
    .where("user_id", "=", id)
    .selectAll()
    .execute();

beforeAll(async () => {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(testDb);
  await recordSyncAudit(args);
});

describe("recordSyncAudit against a real database", () => {
  it("writes exactly one row for the operation", async () => {
    const rows = await rowsForUser(userId);
    expect(rows).toHaveLength(1);
  });

  it("records the transfer as an EXPORT carrying the sync detail in metadata", async () => {
    const [row] = await rowsForUser(userId);
    expect(row.action_type).toBe("EXPORT");
    expect(row.app_id).toBe("manual_sync");
    const metadata = row.metadata as any;
    expect(metadata.feature).toBe("manual_sync");
    expect(metadata.direction).toBe("pull");
    expect(metadata.counts).toEqual({ patients: 12, events: 3 });
    expect(metadata.outcome).toBe("completed");
  });

  /**
   * The weekly verification job recomputes every row's hash in SQL and flags a
   * mismatch as tampering. An audit row that cannot reproduce its own hash is
   * worse than no row at all — it reads as evidence of tampering forever. The
   * digest below is the job's expression from `EventLog.verifyHashes`, scoped to
   * the one row so the assertion neither mutates nor depends on other rows.
   */
  it("writes a hash the verification job can reproduce", async () => {
    const [row] = await rowsForUser(userId);
    const result = await sql<{ computed_hash: string }>`
      SELECT
        encode(
          digest(
            concat_ws('|',
              id::text,
              transaction_id::text,
              action_type,
              table_name,
              row_id,
              changes::text,
              device_id,
              app_id,
              user_id,
              COALESCE(ip_address::text, ''),
              (extract(epoch from created_at) * 1000)::bigint::text
            ),
            'sha256'
          ),
          'hex'
        ) AS computed_hash
      FROM event_logs
      WHERE id = ${row.id}
    `.execute(testDb);

    expect(result.rows[0]?.computed_hash).toBe(row.hash);
  });

  it("still writes a row when the sync itself failed", async () => {
    const failedUserId = uuidV1();
    await recordSyncAudit({
      ...args,
      userId: failedUserId,
      outcome: "failed",
      error: "cursor expired",
    });

    const [row] = await rowsForUser(failedUserId);
    expect(row).toBeDefined();
    expect((row.metadata as any).outcome).toBe("failed");
    expect((row.metadata as any).error).toBe("cursor expired");
    expect(row.metadata).not.toHaveProperty("finished_at");
  });

  it("keeps a client IP in metadata, leaving the hashed column null", async () => {
    const ipUserId = uuidV1();
    await recordSyncAudit({
      ...args,
      feature: "sync",
      userId: ipUserId,
      ipAddress: "203.0.113.7",
    });

    const [row] = await rowsForUser(ipUserId);
    expect(row.ip_address).toBeNull();
    expect((row.metadata as any).ip_address).toBe("203.0.113.7");
  });
});

describe("listSyncEvents against a real database", () => {
  // Rows are stamped with now(); a gap keeps their order unambiguous.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  const pull = async (userId: string, overrides: Record<string, unknown> = {}) => {
    await recordSyncAudit({
      ...args,
      feature: "sync",
      userId,
      direction: "pull",
      counts: { patients: 4 },
      ...overrides,
    });
    await tick();
  };

  const push = async (userId: string, overrides: Record<string, unknown> = {}) => {
    await recordSyncAudit({
      ...args,
      feature: "sync",
      userId,
      direction: "push",
      snapshotTs: undefined,
      counts: { patients: 2 },
      byTable: { patients: { accepted: 2, rejected: 1 } },
      ...overrides,
    });
    await tick();
  };

  const eventsFor = async (userId: string) =>
    (await listSyncEvents({ page: 1, userId })).events;

  it("shows a pull and the push that followed it as one sync", async () => {
    const userId = uuidV1();
    await pull(userId, { snapshotTs: 5_000, ipAddress: "203.0.113.7" });
    await push(userId, { since: 5_000 });

    const events = await eventsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "sync",
      outcome: "completed",
      recordsReceived: 4,
      recordsSent: 2,
      recordsRejected: 1,
      ipAddress: "203.0.113.7",
      error: null,
    });
    expect(events[0].finishedAt).toBeTypeOf("number");
  });

  it("shows a pull with nothing to push as one sync", async () => {
    const userId = uuidV1();
    await pull(userId, { snapshotTs: 6_000 });

    const events = await eventsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ recordsReceived: 4, recordsSent: 0 });
  });

  it("pairs pushes with the right pull when devices share an account", async () => {
    const userId = uuidV1();
    await pull(userId, { snapshotTs: 7_000 });
    await pull(userId, { snapshotTs: 7_001 });
    await push(userId, { since: 7_000 });

    const events = await eventsFor(userId);
    expect(events).toHaveLength(2);
    const [second, first] = events;
    expect(first.recordsSent).toBe(2);
    expect(second.recordsSent).toBe(0);
  });

  it("marks the sync failed, with the push's error, when the push failed", async () => {
    const userId = uuidV1();
    await pull(userId, { snapshotTs: 8_000 });
    await push(userId, {
      since: 8_000,
      outcome: "failed",
      error: "constraint violation",
      counts: {},
      byTable: undefined,
    });

    const events = await eventsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "failed",
      error: "constraint violation",
      finishedAt: null,
    });
  });

  it("pairs a hub's push with its latest pull on the shared watermark", async () => {
    const hubId = `device:${uuidV1()}`;
    const hub = { peerType: "sync_hub", since: 9_000 };
    await pull(hubId, { ...hub, snapshotTs: 9_100 });
    await pull(hubId, { ...hub, snapshotTs: 9_200 });
    await push(hubId, hub);

    const events = await eventsFor(hubId);
    expect(events).toHaveLength(2);
    const [latest, earlier] = events;
    expect(latest.recordsSent).toBe(2);
    expect(earlier.recordsSent).toBe(0);
  });

  it("still shows a push whose pull was never recorded", async () => {
    const userId = uuidV1();
    await push(userId, { since: 1 });

    const events = await eventsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ recordsReceived: 0, recordsSent: 2 });
  });

  it("returns an empty page past the end", async () => {
    const { events, hasNextPage } = await listSyncEvents({
      page: 2,
      userId: uuidV1(),
    });
    expect(events).toEqual([]);
    expect(hasNextPage).toBe(false);
  });
});
