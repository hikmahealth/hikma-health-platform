import { describe, it, expect, vi, beforeEach } from "vitest";

const { getDeltaPage, getDeltaRecords, recordSyncAudit } = vi.hoisted(() => ({
  getDeltaPage: vi.fn(),
  getDeltaRecords: vi.fn(),
  recordSyncAudit: vi.fn(async (_args: any) => undefined),
}));

vi.mock("@/models/sync", () => ({ default: { getDeltaRecords } }));

vi.mock("@/models/sync-paged", () => ({
  getDeltaPage,
  DEFAULT_PAGE_ROWS: 500,
}));
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

// `authedProcedure` runs its middleware even through the caller factory, so the
// context must be the BASE TRPCContext ({ authHeader }) and the token lookup has
// to resolve — passing a pre-built AuthedContext does not bypass the middleware.
// init.ts unwraps this with Effect's `Option.getOrNull`, so build the Option with
// Effect rather than hand-rolling `{_tag:"Some"}` — the internal shape is not a
// stable contract.
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

import { syncQueryRouter } from "@/integrations/trpc/routers/queries/sync";
import { createCallerFactory } from "@/integrations/trpc/init";

const call = createCallerFactory(syncQueryRouter);
const ctx = { authHeader: "Bearer test-token" } as any;

const page = (over: Record<string, any> = {}) => ({
  changes: {},
  nextCursor: null,
  timestamp: 999,
  progress: { table: "patients", bucket: "created", tablesRemaining: 0 },
  totals: {},
  ...over,
});

const auditCalls = (outcome: string) =>
  recordSyncAudit.mock.calls
    .map(([args]) => args)
    .filter((args: any) => args.outcome === outcome);

beforeEach(() => {
  getDeltaPage.mockReset();
  recordSyncAudit.mockReset();
  recordSyncAudit.mockResolvedValue(undefined);
});

describe("sync.backfillPull", () => {
  it("passes the client cursor and page budget through", async () => {
    getDeltaPage.mockResolvedValue(page({ nextCursor: "next" }));

    await call(ctx).backfillPull({
      since: 0,
      cursor: "abc",
      page_bytes: 2_000_000,
    });

    expect(getDeltaPage).toHaveBeenCalledWith(
      expect.objectContaining({ since: 0, cursor: "abc", pageBytes: 2_000_000 }),
    );
  });

  it("falls back to the server's default page size", async () => {
    getDeltaPage.mockResolvedValue(page());

    await call(ctx).backfillPull({
      since: 0,
      cursor: null,
      page_bytes: 2_000_000,
    });

    expect(getDeltaPage).toHaveBeenCalledWith(
      expect.objectContaining({ pageRows: 500 }),
    );
  });

  it("returns snake_case fields on the wire", async () => {
    getDeltaPage.mockResolvedValue(
      page({
        changes: { patients: { created: [], updated: [], deleted: [] } },
        nextCursor: "cur",
        timestamp: 999,
        progress: { table: "patients", bucket: "created", tablesRemaining: 2 },
      }),
    );

    const result = await call(ctx).backfillPull({
      since: 0,
      cursor: null,
      page_bytes: 2_000_000,
    });

    expect(result.next_cursor).toBe("cur");
    expect(result.timestamp).toBe(999);
    expect(result.progress.tables_remaining).toBe(2);
  });

  // Asserted on the tRPC code rather than on `toThrow()` alone: a missing
  // procedure also throws, and these would pass against a router with no
  // backfillPull at all.
  it("rejects a negative since", async () => {
    await expect(
      call(ctx).backfillPull({ since: -1, cursor: null, page_bytes: 2_000_000 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a page_bytes of zero", async () => {
    await expect(
      call(ctx).backfillPull({ since: 0, cursor: null, page_bytes: 0 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  /**
   * `peer_type` is request-body input, and `sync_hub` is not a label — it
   * widens the served entity set to include `users`, `devices` and
   * `device_pin_codes`, while `clinicIds` stays null because a JWT caller has no
   * device record, so `applyClinicScope` filters nothing. Unchecked, any
   * authenticated user read every clinic's users and devices by adding one
   * field. `/api/v2/sync` already refused this; the RPC surface did not.
   *
   * The check is on getDeltaPage never being reached: a FORBIDDEN that still ran
   * the query would have leaked the rows before failing.
   */
  it("refuses a sync_hub claim from a caller with no device", async () => {
    await expect(
      call(ctx).backfillPull({
        since: 0,
        cursor: null,
        page_bytes: 2_000_000,
        peer_type: "sync_hub",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(getDeltaPage).not.toHaveBeenCalled();
  });

  it("still serves the ordinary device peer types", async () => {
    getDeltaPage.mockResolvedValue(page());
    await call(ctx).backfillPull({
      since: 0,
      cursor: null,
      page_bytes: 2_000_000,
      peer_type: "android",
    });
    expect(getDeltaPage).toHaveBeenCalledWith(
      expect.objectContaining({ peerType: "android" }),
    );
  });

  // A refused claim transferred nothing, so it must not leave a start row
  // implying a run began. resolvePeerType throws before the audit write.
  it("writes no audit row for a refused claim", async () => {
    await expect(
      call(ctx).backfillPull({
        since: 0,
        cursor: null,
        page_bytes: 2_000_000,
        peer_type: "sync_hub",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(recordSyncAudit).not.toHaveBeenCalled();
  });
});

describe("sync.backfillPull audit trail", () => {
  // The helper swallows its own failures, so a run that dies leaves no terminal
  // row. A "started" row with nothing after it is what makes that visible —
  // which only works if it is written before the work, not alongside its result.
  it("records the start before reading any data", async () => {
    let startedFirst = false;
    getDeltaPage.mockImplementation(async () => {
      startedFirst = auditCalls("started").length === 1;
      return page();
    });

    await call(ctx).backfillPull({
      since: 0,
      cursor: null,
      page_bytes: 2_000_000,
    });

    expect(startedFirst).toBe(true);
  });

  // A resumed page carries a cursor. Only the first page of a run opens it —
  // otherwise a 2,500-page backfill writes 2,500 start rows.
  it("does not re-record the start on a resumed page", async () => {
    getDeltaPage.mockResolvedValue(page({ nextCursor: "more" }));

    await call(ctx).backfillPull({
      since: 0,
      cursor: "resume-token",
      page_bytes: 2_000_000,
    });

    expect(auditCalls("started")).toHaveLength(0);
  });

  it("records completion once the last page lands, with the run's totals", async () => {
    getDeltaPage.mockResolvedValue(
      page({ nextCursor: null, totals: { patients: 1200, visits: 43 } }),
    );

    await call(ctx).backfillPull({
      since: 0,
      cursor: "resume-token",
      page_bytes: 2_000_000,
    });

    const [completed] = auditCalls("completed");
    expect(completed).toBeDefined();
    expect(completed.counts).toEqual({ patients: 1200, visits: 43 });
    expect(completed.direction).toBe("pull");
    expect(completed.userId).toBe("u1");
    expect(completed.snapshotTs).toBe(999);
    // Started when the run's first page did, not when this last page did.
    expect(completed.startedAt).toBe(999);
  });

  it("does not record completion while pages remain", async () => {
    getDeltaPage.mockResolvedValue(page({ nextCursor: "more" }));

    await call(ctx).backfillPull({
      since: 0,
      cursor: "resume-token",
      page_bytes: 2_000_000,
    });

    expect(auditCalls("completed")).toHaveLength(0);
  });

  it("records the failure, with its reason, when the pull throws", async () => {
    getDeltaPage.mockRejectedValue(new Error("connection reset"));

    await expect(
      call(ctx).backfillPull({
        since: 0,
        cursor: "resume-token",
        page_bytes: 2_000_000,
      }),
    ).rejects.toThrow();

    const [failed] = auditCalls("failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("connection reset");
  });
});

describe("sync.pull audit trail", () => {
  const pullAudits = () =>
    recordSyncAudit.mock.calls
      .map(([args]) => args)
      .filter((args: any) => args.feature === "sync");

  beforeEach(() => {
    getDeltaRecords.mockReset();
  });

  it("records one completed row with what was delivered", async () => {
    getDeltaRecords.mockResolvedValue({
      patients: { created: [{}, {}], updated: [{}], deleted: ["x"] },
    });

    await call(ctx).pull({ last_pulled_at: 5, peer_type: "android" });

    const audits = pullAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: "u1",
      direction: "pull",
      peerType: "android",
      since: 5,
      counts: { patients: 4 },
      outcome: "completed",
    });
    expect(audits[0].startedAt).toBeTypeOf("number");
    expect(audits[0].snapshotTs).toBeTypeOf("number");
  });

  it("records the failure, with its reason, when the pull throws", async () => {
    getDeltaRecords.mockRejectedValue(new Error("db down"));

    await expect(call(ctx).pull({ last_pulled_at: 0 })).rejects.toThrow();

    const audits = pullAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: "failed", error: "db down" });
  });
});
