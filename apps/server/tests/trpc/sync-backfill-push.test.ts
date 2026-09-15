import { describe, it, expect, vi, beforeEach } from "vitest";

const { persistClientChanges, recordSyncAudit } = vi.hoisted(() => ({
  persistClientChanges: vi.fn(),
  recordSyncAudit: vi.fn(async (_args: any) => undefined),
}));

vi.mock("@/models/sync", () => ({ default: { persistClientChanges } }));
vi.mock("@/models/sync-audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/models/sync-audit")>()),
  recordSyncAudit,
}));
vi.mock("@/models/user", () => ({
  default: {
    API: { getById: async () => ({ id: "u1", clinic_id: null }) },
    RoleSchema: {},
  },
}));

// Same reasoning as the pull test: the authed middleware runs through the caller
// factory, so the token lookup must resolve and ctx is the base TRPCContext.
vi.mock("@/models/token", async () => {
  const { Option } = await import("effect");
  return {
    default: {
      getUser: async () => Option.some({ id: "u1", role: "provider" }),
    },
  };
});
vi.mock("@/models/user-clinic-permissions", () => ({
  default: { API: { getByUser: async () => [] } },
}));

import { syncCommandRouter } from "@/integrations/trpc/routers/commands/sync";
import { createCallerFactory } from "@/integrations/trpc/init";

const call = createCallerFactory(syncCommandRouter);
const ctx = { authHeader: "Bearer test-token" } as any;

const auditCalls = (outcome: string) =>
  recordSyncAudit.mock.calls
    .map(([args]) => args)
    .filter((args: any) => args.outcome === outcome);

beforeEach(() => {
  persistClientChanges.mockReset();
  recordSyncAudit.mockReset();
  recordSyncAudit.mockResolvedValue(undefined);
});

describe("sync.backfillPush", () => {
  it("returns the ids the server rejected", async () => {
    persistClientChanges.mockResolvedValue({
      accepted: 2,
      rejected: { patients: ["p1"] },
      byTable: { patients: { accepted: 2, rejected: 1 } },
    });

    const result = await call(ctx).backfillPush({ changes: {}, since: 0 });

    expect(result.rejected.patients).toEqual(["p1"]);
    expect(result.accepted).toBe(2);
  });

  it("exposes per-table counts as by_table on the wire", async () => {
    persistClientChanges.mockResolvedValue({
      accepted: 1,
      rejected: {},
      byTable: { visits: { accepted: 1, rejected: 0 } },
    });

    const result = await call(ctx).backfillPush({ changes: {}, since: 0 });

    expect(result.by_table.visits).toEqual({ accepted: 1, rejected: 0 });
  });

  it("reports an empty rejection map rather than omitting it", async () => {
    persistClientChanges.mockResolvedValue({
      accepted: 0,
      rejected: {},
      byTable: {},
    });

    const result = await call(ctx).backfillPush({ changes: {}, since: 0 });

    expect(result.rejected).toEqual({});
  });

  // The same bucket shape `push` enforces. A looser schema here would accept
  // payloads the neighbouring procedure rejects, on the way to the same model.
  it("rejects a changeset whose buckets are the wrong shape", async () => {
    await expect(
      call(ctx).backfillPush({
        changes: { patients: { created: "not-an-array" } } as any,
        since: 0,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a negative since", async () => {
    await expect(
      call(ctx).backfillPush({ changes: {}, since: -1 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("sync.backfillPush audit trail", () => {
  // Each call is a complete unit of work: the client splits the payload, so
  // unlike the paged pull there is no run to bracket with a start row.
  it("records one completed row carrying what was accepted and what was not", async () => {
    persistClientChanges.mockResolvedValue({
      accepted: 12,
      rejected: { patients: ["p1", "p2"] },
      byTable: { patients: { accepted: 12, rejected: 2 } },
    });

    await call(ctx).backfillPush({
      changes: {},
      since: 5,
      peer_type: "android",
    });

    expect(recordSyncAudit).toHaveBeenCalledTimes(1);
    const [completed] = auditCalls("completed");
    expect(completed.direction).toBe("push");
    expect(completed.peerType).toBe("android");
    expect(completed.since).toBe(5);
    expect(completed.counts).toEqual({ patients: 12 });
    expect(completed.byTable).toEqual({ patients: { accepted: 12, rejected: 2 } });
  });

  it("records the failure, with its reason, when the push throws", async () => {
    persistClientChanges.mockRejectedValue(new Error("deadlock detected"));

    await expect(
      call(ctx).backfillPush({ changes: {}, since: 0 }),
    ).rejects.toThrow();

    const [failed] = auditCalls("failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("deadlock detected");
  });
});

describe("sync.push audit trail", () => {
  const pushAudits = () =>
    recordSyncAudit.mock.calls
      .map(([args]) => args)
      .filter((args: any) => args.feature === "sync");

  it("records one completed row with what was accepted and what was not", async () => {
    persistClientChanges.mockResolvedValue({
      accepted: 2,
      rejected: { patients: ["p1"] },
      byTable: { patients: { accepted: 2, rejected: 1 } },
    });

    await call(ctx).push({ last_pulled_at: 7, changes: {} });

    const audits = pushAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: "u1",
      direction: "push",
      since: 7,
      counts: { patients: 2 },
      byTable: { patients: { accepted: 2, rejected: 1 } },
      outcome: "completed",
    });
    expect(audits[0].startedAt).toBeTypeOf("number");
  });

  it("records the failure, with its reason, when the push throws", async () => {
    persistClientChanges.mockRejectedValue(new Error("constraint violation"));

    await expect(
      call(ctx).push({ last_pulled_at: 0, changes: {} }),
    ).rejects.toThrow();

    const audits = pushAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: "failed",
      error: "constraint violation",
    });
  });
});
