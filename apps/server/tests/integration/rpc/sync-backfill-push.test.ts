import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import { v1 as uuidV1 } from "uuid";
import { testDb } from "../setup";

vi.mock("@/db", () => ({ default: testDb }));

import { syncCommandRouter } from "@/integrations/trpc/routers/commands/sync";
import { createCallerFactory } from "@/integrations/trpc/init";
import Token from "@/models/token";

// Unmocked counterpart to the router tests: rejections must be keyed by the
// client's table names, or the client can't resolve them.
const call = createCallerFactory(syncCommandRouter);

const patientIds: string[] = [];
const clinicIds: string[] = [];
const userIds: string[] = [];
const tokens: string[] = [];

let ctx: { authHeader: string };

const pushPatient = (id: string, updatedAt: string) => ({
  patients: {
    created: [
      {
        id,
        given_name: "Backfill",
        surname: "TestPatient",
        date_of_birth: "1990-01-01",
        sex: "female",
        is_deleted: false,
        created_at: "2026-06-01T00:00:00Z",
        updated_at: updatedAt,
        metadata: {},
      },
    ],
    updated: [],
    deleted: [],
  },
});

beforeAll(async () => {
  const clinicId = uuidV1();
  clinicIds.push(clinicId);
  await testDb
    .insertInto("clinics")
    .values({
      id: clinicId,
      name: "Backfill Push Test Clinic",
      is_deleted: false,
      is_archived: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    } as any)
    .execute();

  const userId = uuidV1();
  userIds.push(userId);
  await testDb
    .insertInto("users")
    .values({
      id: userId,
      name: "Backfill Push Test User",
      role: "provider",
      email: `backfill-push-${userId}@example.com`,
      hashed_password: "not-a-real-hash",
      instance_url: null,
      clinic_id: clinicId,
      is_deleted: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    } as any)
    .execute();

  const token = `backfill-push-test-${uuidV1()}`;
  tokens.push(token);
  await testDb
    .insertInto("tokens")
    .values({
      token: Token.hash(token),
      user_id: userId,
      expiry: sql`now() + interval '1 hour'`,
    } as any)
    .execute();

  ctx = { authHeader: `Bearer ${token}` };
});

afterAll(async () => {
  for (const token of tokens)
    await testDb.deleteFrom("tokens").where("token", "=", Token.hash(token)).execute();
  for (const id of patientIds)
    await testDb.deleteFrom("patients").where("id", "=", id).execute();
  for (const id of userIds)
    await testDb.deleteFrom("users").where("id", "=", id).execute();
  for (const id of clinicIds)
    await testDb.deleteFrom("clinics").where("id", "=", id).execute();
});

describe("sync.backfillPush against a real database", () => {
  it("accepts a first-time push and reports it per table", async () => {
    const id = uuidV1();
    patientIds.push(id);

    const result = await call(ctx as any).backfillPush({
      changes: pushPatient(id, "2026-06-01T00:00:00Z") as any,
      since: 0,
      peer_type: "android",
    });

    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual({});
    expect(result.by_table.patients).toEqual({ accepted: 1, rejected: 0 });
  });

  // Otherwise the client marks the record synced and the next pull overwrites it.
  it("names the record the staleness guard rejected, under the client's table name", async () => {
    const id = uuidV1();
    patientIds.push(id);

    await call(ctx as any).backfillPush({
      changes: pushPatient(id, "2026-06-01T00:00:00Z") as any,
      since: 0,
      peer_type: "android",
    });

    const result = await call(ctx as any).backfillPush({
      changes: pushPatient(id, "2026-01-01T00:00:00Z") as any,
      since: 0,
      peer_type: "android",
    });

    expect(result.accepted).toBe(0);
    expect(result.rejected.patients).toEqual([id]);
    expect(result.by_table.patients).toEqual({ accepted: 0, rejected: 1 });
  });

  it("refuses an unauthenticated push", async () => {
    await expect(
      call({ authHeader: null } as any).backfillPush({
        changes: {},
        since: 0,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
