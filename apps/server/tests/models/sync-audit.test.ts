import { describe, it, expect, vi, beforeEach } from "vitest";

const { logEvent } = vi.hoisted(() => ({
  logEvent: vi.fn(
    async (_db: unknown, _params: any, _context: any) => undefined,
  ),
}));

vi.mock("@/models/event-logs", () => ({
  default: { logEvent },
}));

import { Logger } from "@hikmahealth/js-utils";
import {
  acceptedCounts,
  countChanges,
  recordSyncAudit,
} from "@/models/sync-audit";

const base = {
  feature: "manual_sync" as const,
  userId: "u1",
  direction: "pull" as const,
  peerType: "android",
  since: 0,
  snapshotTs: 1_800_000_000_000,
  startedAt: 1_800_000_000_000,
  counts: { patients: 12 },
  outcome: "completed" as const,
};

/** The params object handed to EventLog.logEvent by the last call. */
const lastParams = () => logEvent.mock.calls.at(-1)![1] as any;
/** The request context handed to EventLog.logEvent by the last call. */
const lastContext = () => logEvent.mock.calls.at(-1)![2] as any;

beforeEach(() => {
  logEvent.mockReset();
  logEvent.mockResolvedValue(undefined);
});

describe("recordSyncAudit", () => {
  it("writes a single audit row per operation", async () => {
    await recordSyncAudit(base);
    expect(logEvent).toHaveBeenCalledTimes(1);
  });

  it("records the operation as an EXPORT", async () => {
    await recordSyncAudit(base);
    expect(lastParams().actionType).toBe("EXPORT");
  });

  // A push is an EXPORT too; the direction lives in metadata.
  it("records the direction in metadata rather than the action type", async () => {
    await recordSyncAudit({ ...base, direction: "push" });
    expect(lastParams().actionType).toBe("EXPORT");
    expect(lastParams().metadata.direction).toBe("push");
  });

  it("attributes the row to the acting user", async () => {
    await recordSyncAudit(base);
    expect(lastParams().userId).toBe("u1");
  });

  it("records what moved, from when, and how it ended", async () => {
    await recordSyncAudit(base);
    const metadata = lastParams().metadata;
    expect(metadata.feature).toBe("manual_sync");
    expect(metadata.peer_type).toBe("android");
    expect(metadata.since).toBe(0);
    expect(metadata.snapshot_ts).toBe(1_800_000_000_000);
    expect(metadata.counts).toEqual({ patients: 12 });
    expect(metadata.outcome).toBe("completed");
  });

  // A push that accepted 12 records and rejected 40 is not described by "12".
  // The per-table breakdown is what the client was told, so the audit says the
  // same thing rather than a rosier half of it.
  it("records the per-table breakdown when the caller has one", async () => {
    await recordSyncAudit({
      ...base,
      direction: "push",
      byTable: { patients: { accepted: 12, rejected: 40 } },
    });
    expect(lastParams().metadata.by_table).toEqual({
      patients: { accepted: 12, rejected: 40 },
    });
  });

  it("records when the request started", async () => {
    await recordSyncAudit(base);
    expect(lastParams().metadata.started_at).toBe(1_800_000_000_000);
  });

  it("stamps a completion date on a completed operation", async () => {
    const before = Date.now();
    await recordSyncAudit(base);
    const finishedAt = lastParams().metadata.finished_at;
    expect(finishedAt).toBeGreaterThanOrEqual(before);
    expect(finishedAt).toBeLessThanOrEqual(Date.now());
  });

  it("has no completion date when the operation failed", async () => {
    await recordSyncAudit({ ...base, outcome: "failed", error: "boom" });
    expect(lastParams().metadata).not.toHaveProperty("finished_at");
  });

  it("has no completion date on a start row", async () => {
    await recordSyncAudit({ ...base, outcome: "started" });
    expect(lastParams().metadata).not.toHaveProperty("finished_at");
  });

  it("omits snapshot_ts when the operation has no watermark", async () => {
    const { snapshotTs: _, ...push } = base;
    await recordSyncAudit({ ...push, direction: "push" });
    expect(lastParams().metadata).not.toHaveProperty("snapshot_ts");
  });

  it("tags ordinary sync by feature and app id", async () => {
    await recordSyncAudit({ ...base, feature: "sync" });
    expect(lastParams().metadata.feature).toBe("sync");
    expect(lastContext().appId).toBe("sync");
  });

  // inet::text renders with a netmask, so a column IP would break the hash.
  it("keeps the client IP in metadata, never the hashed column", async () => {
    await recordSyncAudit({ ...base, ipAddress: "203.0.113.7" });
    expect(lastParams().metadata.ip_address).toBe("203.0.113.7");
    expect(lastContext().ipAddress).toBeNull();
  });

  // "unknown" is getClientIp's fallback; a spoofed header can be anything.
  it.each(["unknown", "not-an-ip", "", null, undefined])(
    "drops %j instead of recording it as an IP",
    async (ipAddress) => {
      await recordSyncAudit({ ...base, ipAddress });
      expect(lastParams().metadata).not.toHaveProperty("ip_address");
    },
  );

  // A paged pull has no such breakdown — it knows only what it delivered.
  it("omits the breakdown entirely when the caller has none", async () => {
    await recordSyncAudit(base);
    expect(lastParams().metadata).not.toHaveProperty("by_table");
  });

  it("omits the error key entirely when the operation succeeded", async () => {
    await recordSyncAudit(base);
    expect(lastParams().metadata).not.toHaveProperty("error");
  });

  it("records the failure reason when the operation failed", async () => {
    await recordSyncAudit({
      ...base,
      outcome: "failed",
      error: "cursor expired",
    });
    expect(lastParams().metadata.outcome).toBe("failed");
    expect(lastParams().metadata.error).toBe("cursor expired");
  });

  // `changes` is the only column in the integrity hash payload, and the
  // verification job recomputes it from the *jsonb* rendering of the column —
  // which re-spaces anything non-empty and so would never match the hash the
  // writer computed from JSON.stringify. `{}` renders identically either way.
  it("leaves changes empty so the row survives hash verification", async () => {
    await recordSyncAudit(base);
    expect(lastParams().changes).toEqual({});
  });

  it("marks the row as manual sync from the peer that asked for it", async () => {
    await recordSyncAudit(base);
    expect(lastContext().appId).toBe("manual_sync");
    expect(lastContext().deviceId).toBe("android");
  });

  // The whole point of the helper: a failed audit write must not fail the sync
  // the user asked for. It must still be visible, or a silently missing audit
  // row is indistinguishable from a sync that never happened.
  it("never throws when the audit write fails, but does log it", async () => {
    const logged = vi.spyOn(Logger, "error").mockImplementation(() => {});
    logEvent.mockRejectedValueOnce(new Error("db down"));

    await expect(recordSyncAudit(base)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);

    logged.mockRestore();
  });
});

describe("countChanges", () => {
  it("sums created, updated and deleted per table", () => {
    expect(
      countChanges({
        patients: { created: [1, 2], updated: [3], deleted: ["x"] },
        visits: { created: [], updated: [], deleted: [] },
      }),
    ).toEqual({ patients: 4, visits: 0 });
  });
});

describe("acceptedCounts", () => {
  it("keeps only the accepted half of each tally", () => {
    expect(
      acceptedCounts({ patients: { accepted: 3, rejected: 2 } }),
    ).toEqual({ patients: 3 });
  });
});
