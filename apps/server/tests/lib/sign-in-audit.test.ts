// @vitest-environment node
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import bcrypt from "bcrypt";
import { sql, type Kysely } from "kysely";
import type { DB } from "@hikmahealth/database/types/schema/hh";

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock("@/db", () => ({
  default: new Proxy(
    {},
    {
      get: (_, key) => {
        const target = holder.db as Record<PropertyKey, unknown>;
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    },
  ),
}));
vi.mock("@tanstack/react-start/server", () => ({ setCookie: vi.fn() }));

import { createPgliteKysely, migrateToLatest } from "../helpers/pglite-kysely";
import { attemptSignIn } from "@/lib/auth/sign-in";
import {
  type SignInClient,
  UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW,
  recordSignInFailure,
  recordSignInRateLimited,
  recordSignOut,
  resetSignInAuditState,
} from "@/lib/auth/sign-in-audit";

const PASSWORD = "correct-horse-battery";
const EMAIL = "nurse.joy@example.org";
let db: Kysely<DB>;
let userId: string;
let ipCounter = 0;

const signInRequest = (email: string, password: string) =>
  new Request("http://localhost/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${++ipCounter}`,
      "user-agent": "vitest",
    },
    body: JSON.stringify({ email, password }),
  });

const auditRows = () =>
  db
    .selectFrom("event_logs")
    .selectAll()
    .where("action_type", "in", ["SIGN_IN", "SIGN_IN_FAILED", "SIGN_OUT"])
    .orderBy("created_at")
    .execute();

const client = (ipAddress: string | null): SignInClient => ({
  channel: "web",
  ipAddress,
  userAgent: "vitest",
});

beforeAll(async () => {
  db = createPgliteKysely();
  holder.db = db;
  await migrateToLatest(db);
  const clinic = await db
    .selectFrom("clinics")
    .select("id")
    .executeTakeFirstOrThrow();
  userId = "0190a1b2-0000-7000-8000-000000000001";
  await db
    .insertInto("users")
    .values({
      id: userId,
      name: "Nurse Joy",
      role: "provider",
      email: EMAIL,
      hashed_password: await bcrypt.hash(PASSWORD, 4),
      clinic_id: clinic.id,
      instance_url: null,
      is_deleted: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    })
    .execute();
}, 60_000);

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  resetSignInAuditState();
  // event_logs refuses DELETE, so its triggers are lifted to reset it.
  await sql`ALTER TABLE event_logs DISABLE TRIGGER USER`.execute(db);
  await sql`DELETE FROM event_logs`.execute(db);
  await sql`ALTER TABLE event_logs ENABLE TRIGGER USER`.execute(db);
});

describe("sign-in audit", () => {
  it("records a successful web sign-in with who and from where", async () => {
    const outcome = await attemptSignIn(signInRequest(EMAIL, PASSWORD), "web");

    expect(outcome.kind).toBe("ok");
    const [row, ...rest] = await auditRows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      action_type: "SIGN_IN",
      user_id: userId,
      row_id: userId,
      app_id: "web",
    });
    expect(String(row.ip_address)).toContain(`203.0.113.${ipCounter}`);
  });

  it("does not record a successful device sign-in, which every sync makes", async () => {
    const outcome = await attemptSignIn(
      signInRequest(EMAIL, PASSWORD),
      "mobile",
    );

    expect(outcome.kind).toBe("ok");
    expect(await auditRows()).toHaveLength(0);
  });

  it("records a wrong password against the account it targeted", async () => {
    const outcome = await attemptSignIn(
      signInRequest(EMAIL, "wrong-password"),
      "mobile",
    );

    expect(outcome.kind).toBe("invalid");
    const [row] = await auditRows();
    expect(row).toMatchObject({
      action_type: "SIGN_IN_FAILED",
      user_id: userId,
      app_id: "mobile",
      metadata: { reason: "invalid-credentials", email: EMAIL },
    });
  });

  it("stores nothing of what was typed when no account matches", async () => {
    const typed = "my-actual-password-typed-in-the-wrong-box";
    await attemptSignIn(signInRequest(typed, "anything"), "web");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action_type: "SIGN_IN_FAILED",
      user_id: "unauthenticated",
      metadata: { account_found: false },
    });
    expect(JSON.stringify(rows)).not.toContain(typed);
  });

  it("does not record a soft-deleted account as found", async () => {
    await db
      .updateTable("users")
      .set({ is_deleted: true })
      .where("id", "=", userId)
      .execute();
    try {
      await attemptSignIn(signInRequest(EMAIL, PASSWORD), "web");
      const [row] = await auditRows();
      expect(row).toMatchObject({
        action_type: "SIGN_IN_FAILED",
        user_id: "unauthenticated",
      });
    } finally {
      await db
        .updateTable("users")
        .set({ is_deleted: false })
        .where("id", "=", userId)
        .execute();
    }
  });

  it("records one row per rate-limited key per window, however many requests", async () => {
    const limit = { scope: "ip" as const, retryAfterMs: 60_000 };
    for (let attempt = 0; attempt < 50; attempt++) {
      await recordSignInRateLimited(client("198.51.100.1"), {
        ...limit,
        key: "ip:198.51.100.1",
      });
    }
    await recordSignInRateLimited(client("198.51.100.2"), {
      ...limit,
      key: "ip:198.51.100.2",
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].metadata).toMatchObject({
      reason: "rate-limited",
      limit_scope: "ip",
    });
  });

  it("records the same key again once its window has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const limit = { scope: "ip" as const, key: "ip:x", retryAfterMs: 1_000 };
      await recordSignInRateLimited(client(null), limit);
      vi.setSystemTime(Date.now() + 1_001);
      await recordSignInRateLimited(client(null), limit);
    } finally {
      vi.useRealTimers();
    }

    expect(await auditRows()).toHaveLength(2);
  });

  it("names the targeted account when an account limit trips", async () => {
    await recordSignInRateLimited(client(null), {
      scope: "account",
      key: "acct",
      retryAfterMs: 60_000,
      email: EMAIL,
    });

    const [row] = await auditRows();
    expect(row).toMatchObject({
      user_id: userId,
      metadata: { limit_scope: "account", email: EMAIL },
    });
  });

  it("caps rows for unknown emails and reports what it dropped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let attempt = 0; attempt < 500; attempt++) {
        await recordSignInFailure(client(null), `nobody-${attempt}@x.org`);
      }
      expect(await auditRows()).toHaveLength(
        UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW,
      );

      vi.setSystemTime(Date.now() + 60_001);
      await recordSignInFailure(client(null), "nobody-late@x.org");
    } finally {
      vi.useRealTimers();
    }

    const rows = await auditRows();
    expect(rows).toHaveLength(UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW + 1);
    expect(rows.at(-1)?.metadata).toMatchObject({
      suppressed_before: 500 - UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW,
    });
  });

  it("records every failure against a real account, past the cap", async () => {
    const attempts = UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW + 20;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await recordSignInFailure(client(null), EMAIL);
    }

    expect(await auditRows()).toHaveLength(attempts);
  });

  it("keeps the row when the forwarded address is not an IP", async () => {
    await recordSignOut(client("not-an-ip"), userId);

    const [row] = await auditRows();
    expect(row).toMatchObject({ action_type: "SIGN_OUT", user_id: userId });
    expect(row.ip_address).toBeNull();
  });
});
