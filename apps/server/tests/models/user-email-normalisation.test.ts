// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import {
  emailForUpdate,
  normaliseEmail,
  normaliseName,
} from "@/lib/user-identity";

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

// The model imports the app `db` at load; route it to the in-memory one.
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

import { createPgliteKysely, migrateToLatest } from "../helpers/pglite-kysely";
import User from "@/models/user";

describe("normaliseEmail / normaliseName", () => {
  it("trims and lowercases emails", () => {
    expect(normaliseEmail("  Amina@Example.ORG \n")).toBe("amina@example.org");
  });

  it("trims names without changing their case", () => {
    expect(normaliseName("  Amina Clinic Lead ")).toBe("Amina Clinic Lead");
  });
});

describe("emailForUpdate", () => {
  it("keeps an unchanged email exactly as stored, capitals included", () => {
    expect(emailForUpdate("John@Example.org", "John@Example.org")).toBe(
      "John@Example.org",
    );
  });

  it("normalises an email that was changed", () => {
    expect(emailForUpdate(" New@Example.org ", "John@Example.org")).toBe(
      "new@example.org",
    );
  });

  it("normalises when there is no stored row", () => {
    expect(emailForUpdate("New@Example.org", undefined)).toBe(
      "new@example.org",
    );
  });
});

describe("User.API with a database", () => {
  let db: Kysely<DB>;
  let clinicId: string;
  let creatorId: string;

  beforeAll(async () => {
    db = createPgliteKysely() as Kysely<DB>;
    holder.db = db;
    await migrateToLatest(db);
    clinicId = (
      await db.selectFrom("clinics").select("id").executeTakeFirstOrThrow()
    ).id;
    creatorId = (
      await db.selectFrom("users").select("id").executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await db.destroy();
  });

  const stored = (id: string) =>
    db
      .selectFrom("users")
      .select(["email", "name"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  const newUser = (email: string, name: string) =>
    ({
      id: "",
      name,
      role: "provider",
      email,
      hashed_password: "a-password-for-tests",
      instance_url: null,
      clinic_id: clinicId,
      created_at: new Date(),
      updated_at: new Date(),
      is_deleted: false,
      deleted_at: null,
      last_modified: new Date(),
      server_created_at: new Date(),
    }) as unknown as User.EncodedT;

  it("stores a new user's email lowercased and trimmed, and the name trimmed", async () => {
    const id = await User.API.create(
      newUser("  Nurse.Joy@Example.ORG ", "  Nurse Joy "),
      creatorId,
    );
    if (id === null) throw new Error("create failed");

    expect(await stored(id)).toEqual({
      email: "nurse.joy@example.org",
      name: "Nurse Joy",
    });
  });

  it("leaves an existing mixed-case email alone when an edit does not change it", async () => {
    const id = await User.API.create(
      newUser("legacy@example.org", "Legacy"),
      creatorId,
    );
    if (id === null) throw new Error("create failed");
    await db
      .updateTable("users")
      .set({ email: "Legacy@Example.org" })
      .where("id", "=", id)
      .execute();

    await User.API.update(id, {
      ...newUser("Legacy@Example.org", " Legacy User "),
      id,
    });

    expect(await stored(id)).toEqual({
      email: "Legacy@Example.org",
      name: "Legacy User",
    });
  });

  it("normalises an email that an edit changes", async () => {
    const id = await User.API.create(
      newUser("old@example.org", "Mover"),
      creatorId,
    );
    if (id === null) throw new Error("create failed");

    await User.API.update(id, {
      ...newUser(" New.Address@Example.org ", "Mover"),
      id,
    });

    expect((await stored(id)).email).toBe("new.address@example.org");
  });
});
