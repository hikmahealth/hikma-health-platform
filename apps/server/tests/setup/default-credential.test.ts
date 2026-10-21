// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Kysely, sql } from "kysely";
import bcrypt from "bcrypt";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import { createPgliteKysely } from "../helpers/pglite-kysely";
import * as initialTables from "../../../../database/migrations/20191125_initial_tables";
import * as initialUser from "../../../../database/migrations/20191126_initial_user";
import * as instanceSetup from "../../../../database/migrations/20261021_create_instance_setup";
import {
  SEED_ADMIN_EMAIL,
  SEED_ADMIN_HASH,
  getDefaultCredentialStatus,
} from "@/lib/setup/default-credential";

let db: Kysely<DB>;

const seedAdmin = () =>
  db
    .selectFrom("users")
    .select(["id", "hashed_password"])
    .where("email", "=", SEED_ADMIN_EMAIL)
    .executeTakeFirstOrThrow();

/** An install that predates first-run setup: the seed admin is old, then the migration runs. */
const existingDeployment = async () => {
  await sql`UPDATE users SET created_at = now() - '30 days'::interval`.execute(
    db,
  );
  await instanceSetup.up(db);
};

beforeEach(async () => {
  db = createPgliteKysely() as Kysely<DB>;
  await initialTables.up(db);
  await initialUser.up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("getDefaultCredentialStatus", () => {
  it("knows the hash the seed migration writes", async () => {
    expect((await seedAdmin()).hashed_password).toBe(SEED_ADMIN_HASH);
  });

  it("flags an existing deployment that never changed the default password", async () => {
    await existingDeployment();
    const { id } = await seedAdmin();

    expect(await getDefaultCredentialStatus(db)).toEqual({
      kind: "in-use",
      userId: id,
    });
  });

  it("clears once the password is changed", async () => {
    await existingDeployment();
    await db
      .updateTable("users")
      .set({ hashed_password: await bcrypt.hash("a-new-password-1", 4) })
      .where("email", "=", SEED_ADMIN_EMAIL)
      .execute();

    expect(await getDefaultCredentialStatus(db)).toEqual({
      kind: "not-in-use",
    });
  });

  it("clears once the seed admin is deleted", async () => {
    await existingDeployment();
    await db
      .updateTable("users")
      .set({ is_deleted: true, deleted_at: new Date() })
      .where("email", "=", SEED_ADMIN_EMAIL)
      .execute();

    expect(await getDefaultCredentialStatus(db)).toEqual({
      kind: "not-in-use",
    });
  });

  it("clears when the seed admin's email was changed", async () => {
    await existingDeployment();
    await db
      .updateTable("users")
      .set({ email: "lead@example.org" })
      .where("email", "=", SEED_ADMIN_EMAIL)
      .execute();

    expect(await getDefaultCredentialStatus(db)).toEqual({
      kind: "not-in-use",
    });
  });

  it("never flags a fresh install, whose seed password the migration already replaced", async () => {
    await instanceSetup.up(db);

    expect(await getDefaultCredentialStatus(db)).toEqual({
      kind: "not-in-use",
    });
  });
});
