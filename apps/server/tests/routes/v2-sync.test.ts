import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getDeltaRecords,
  persistClientChanges,
  verifyCredentials,
  getByApiKey,
  recordSyncAudit,
} = vi.hoisted(() => ({
  getDeltaRecords: vi.fn(),
  persistClientChanges: vi.fn(),
  verifyCredentials: vi.fn(),
  getByApiKey: vi.fn(),
  recordSyncAudit: vi.fn(async (_args: any) => undefined),
}));

vi.mock("@/models/sync", () => ({
  default: { getDeltaRecords, persistClientChanges },
}));
vi.mock("@/models/user", () => ({ default: { verifyCredentials } }));
vi.mock("@/models/clinic", () => ({ default: { getById: vi.fn() } }));
vi.mock("@/models/device", () => ({
  default: {
    DEVICE_TYPE: { SYNC_HUB: "sync_hub" },
    API: { getByApiKey },
  },
}));
vi.mock("@/models/sync-audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/models/sync-audit")>()),
  recordSyncAudit,
}));

import { Route } from "@/routes/api/v2.sync";

const handlers = (Route.options as any).server.handlers;

// Each test gets its own IP so the shared rate limiter never trips.
let ipCounter = 0;
const request = (
  method: "GET" | "POST",
  query: string,
  authorization: string,
  body?: unknown,
) =>
  new Request(`http://localhost/api/v2/sync?${query}`, {
    method,
    headers: {
      Authorization: authorization,
      "x-forwarded-for": `198.51.100.${++ipCounter}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const basic = `Basic ${Buffer.from("a@b.c:pw").toString("base64")}`;
const audits = () => recordSyncAudit.mock.calls.map(([args]) => args as any);

beforeEach(() => {
  vi.clearAllMocks();
  verifyCredentials.mockResolvedValue({ id: "u1", clinic_id: null });
});

describe("GET /api/v2/sync audit trail", () => {
  it("records one completed row with what was delivered", async () => {
    getDeltaRecords.mockResolvedValue({
      patients: { created: [{}], updated: [{}], deleted: [] },
    });

    const res = await handlers.GET({
      request: request("GET", "last_pulled_at=5&peerType=android", basic),
    });

    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      feature: "sync",
      userId: "u1",
      direction: "pull",
      peerType: "android",
      since: 5,
      counts: { patients: 2 },
      outcome: "completed",
    });
    expect(audits()[0].ipAddress).toMatch(/^198\.51\.100\./);
  });

  it("records exactly one failed row when the pull throws", async () => {
    getDeltaRecords.mockRejectedValue(new Error("db down"));

    const res = await handlers.GET({
      request: request("GET", "last_pulled_at=0", basic),
    });

    expect(res.status).toBe(500);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      userId: "u1",
      outcome: "failed",
      error: "db down",
    });
  });

  it("records a rejected login as unauthenticated", async () => {
    verifyCredentials.mockRejectedValue(new Error("Invalid credentials"));

    const res = await handlers.GET({
      request: request("GET", "last_pulled_at=0", basic),
    });

    expect(res.status).toBe(401);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      userId: "unauthenticated",
      outcome: "failed",
    });
  });

  it("attributes a hub's pull to its device", async () => {
    getByApiKey.mockResolvedValue({ id: "hub-1", device_type: "sync_hub" });
    getDeltaRecords.mockResolvedValue({});

    await handlers.GET({
      request: request("GET", "peerType=sync_hub", "Bearer hub-key"),
    });

    expect(audits()[0]).toMatchObject({
      userId: "device:hub-1",
      outcome: "completed",
    });
  });
});

describe("POST /api/v2/sync audit trail", () => {
  it("records what was accepted and what was not", async () => {
    persistClientChanges.mockResolvedValue({
      accepted: 1,
      rejected: { patients: ["p2"] },
      byTable: { patients: { accepted: 1, rejected: 1 } },
    });

    const res = await handlers.POST({
      request: request("POST", "last_pulled_at=3", basic, {}),
    });

    expect(res.status).toBe(200);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      userId: "u1",
      direction: "push",
      since: 3,
      counts: { patients: 1 },
      byTable: { patients: { accepted: 1, rejected: 1 } },
      outcome: "completed",
    });
  });

  it("records exactly one failed row when the push throws", async () => {
    persistClientChanges.mockRejectedValue(new Error("constraint violation"));

    const res = await handlers.POST({
      request: request("POST", "last_pulled_at=0", basic, {}),
    });

    expect(res.status).toBe(500);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      outcome: "failed",
      error: "constraint violation",
    });
  });
});

describe("/api/v2/sync rate limiting", () => {
  const sharedIp = (n: number) => `203.0.113.${n}`;
  const basicFor = (email: string) =>
    `Basic ${Buffer.from(`${email}:pw`).toString("base64")}`;
  const pull = (ip: string, authorization: string) =>
    handlers.GET({
      request: new Request("http://localhost/api/v2/sync?last_pulled_at=0", {
        headers: { Authorization: authorization, "x-forwarded-for": ip },
      }),
    });

  beforeEach(() => {
    getDeltaRecords.mockResolvedValue({});
  });

  it("gives two accounts behind one router separate budgets", async () => {
    const ip = sharedIp(1);
    for (let i = 0; i < 120; i++) {
      expect((await pull(ip, basicFor("a@x.org"))).status).toBe(200);
    }

    expect((await pull(ip, basicFor("a@x.org"))).status).toBe(429);
    expect((await pull(ip, basicFor("b@x.org"))).status).toBe(200);
  });

  it("does not let one account's budget follow it to another IP", async () => {
    for (let i = 0; i < 120; i++) await pull(sharedIp(2), basicFor("c@x.org"));

    expect((await pull(sharedIp(2), basicFor("c@x.org"))).status).toBe(429);
    expect((await pull(sharedIp(3), basicFor("c@x.org"))).status).toBe(200);
  });

  // The claimed account is unverified, so rotating it must not be a bypass.
  it("caps an IP rotating claimed accounts at the backstop", async () => {
    const ip = sharedIp(4);
    for (let i = 0; i < 1_200; i++) {
      expect((await pull(ip, basicFor(`user${i}@x.org`))).status).not.toBe(429);
    }

    expect((await pull(ip, basicFor("fresh@x.org"))).status).toBe(429);
  });

  it("puts requests naming no account in one per-IP bucket", async () => {
    const ip = sharedIp(5);
    for (let i = 0; i < 120; i++) await pull(ip, "");

    expect((await pull(ip, "")).status).toBe(429);
  });
});
