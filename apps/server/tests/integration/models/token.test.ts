import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { sql } from "kysely";
import { Option } from "effect";
import { v1 as uuidV1 } from "uuid";
import { testDb } from "../setup";

vi.mock("@/db", () => ({ default: testDb }));

import Token from "@/models/token";

const clinicId = uuidV1();
const userId = uuidV1();
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

const storedTokens = async () =>
  (
    await testDb
      .selectFrom("tokens")
      .where("user_id", "=", userId)
      .select("token")
      .execute()
  ).map((r) => r.token);

beforeAll(async () => {
  await testDb
    .insertInto("clinics")
    .values({
      id: clinicId,
      name: "Token Test Clinic",
      is_deleted: false,
      is_archived: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    } as any)
    .execute();
  await testDb
    .insertInto("users")
    .values({
      id: userId,
      name: "Token Test User",
      role: "registrar",
      email: `token-${userId}@example.com`,
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
});

afterAll(async () => {
  await testDb.deleteFrom("tokens").where("user_id", "=", userId).execute();
  await testDb.deleteFrom("users").where("id", "=", userId).execute();
  await testDb.deleteFrom("clinics").where("id", "=", clinicId).execute();
});

describe("Token storage", () => {
  it("stores the SHA-256 digest, never the raw token", async () => {
    const token = await Token.create(userId, inAnHour());

    const stored = await storedTokens();
    expect(stored).toContain(Token.hash(token));
    expect(stored).not.toContain(token);
  });

  it("resolves the raw token to its user", async () => {
    const token = await Token.create(userId, inAnHour());

    const user = await Token.getUser(token);
    expect(Option.getOrUndefined(user)?.id).toBe(userId);
  });

  // A leaked database row must not work as a credential.
  it("rejects the stored digest presented as a token", async () => {
    const token = await Token.create(userId, inAnHour());

    expect(Option.isNone(await Token.getUser(Token.hash(token)))).toBe(true);
  });

  it("invalidate removes the row for the raw token", async () => {
    const token = await Token.create(userId, inAnHour());
    await Token.invalidate(token);

    expect(await storedTokens()).not.toContain(Token.hash(token));
    expect(Option.isNone(await Token.getUser(token))).toBe(true);
  });
});
