// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Kysely, sql } from "kysely";
import { createPgliteKysely } from "../helpers/pglite-kysely";
import * as initialTables from "../../../../database/migrations/20191125_initial_tables";
import * as initialUser from "../../../../database/migrations/20191126_initial_user";
import * as instanceSetup from "../../../../database/migrations/20261021_create_instance_setup";

const SEED_EMAIL = "admin@hikmahealth.org";
const SEED_HASH =
  "$2b$14$PPY9X2ZxFG93IU9CK4FUtOJW0d11zjHuODO6oJM5UNn59aXjp5h..";

let db: Kysely<any>;

const seedAdmin = () =>
  db
    .selectFrom("users")
    .select(["hashed_password", "is_deleted"])
    .where("email", "=", SEED_EMAIL)
    .executeTakeFirstOrThrow();

const setupRow = () =>
  db.selectFrom("instance_setup").selectAll().executeTakeFirstOrThrow();

const backdateSeedAdmin = (age: string) =>
  sql`UPDATE users SET created_at = now() - ${age}::interval WHERE email = ${SEED_EMAIL}`.execute(
    db,
  );

beforeEach(async () => {
  db = createPgliteKysely();
  await initialTables.up(db);
  await initialUser.up(db);
});

afterEach(async () => {
  await db.destroy();
});

describe("20261021_create_instance_setup", () => {
  describe("brand-new install (seed admin created in this migrate run)", () => {
    it("leaves setup pending with no token yet", async () => {
      await instanceSetup.up(db);

      const row = await setupRow();
      expect(row.id).toBe(1);
      expect(row.completed_at).toBeNull();
      expect(row.token).toBeNull();
    });

    it("replaces the shared default password with an unmatchable bcrypt hash", async () => {
      await instanceSetup.up(db);

      const { hashed_password } = await seedAdmin();
      expect(hashed_password).not.toBe(SEED_HASH);
      expect(hashed_password).toMatch(/^\$2b\$14\$[./A-Za-z0-9]{53}$/);
    });

    it("generates a different replacement hash on every install", async () => {
      await instanceSetup.up(db);
      const first = (await seedAdmin()).hashed_password;

      await instanceSetup.down(db);
      await instanceSetup.up(db);
      const second = (await seedAdmin()).hashed_password;

      expect(second).not.toBe(first);
    });

    it("still counts as fresh at the edge of the 5 minute window", async () => {
      await backdateSeedAdmin("4 minutes 50 seconds");
      await instanceSetup.up(db);

      expect((await setupRow()).completed_at).toBeNull();
    });
  });

  describe("existing deployment", () => {
    it("is marked complete and keeps the seed admin's password", async () => {
      await backdateSeedAdmin("400 days");
      await instanceSetup.up(db);

      expect((await setupRow()).completed_at).toBeInstanceOf(Date);
      expect((await seedAdmin()).hashed_password).toBe(SEED_HASH);
    });

    it("is complete just past the 5 minute window", async () => {
      await backdateSeedAdmin("5 minutes 10 seconds");
      await instanceSetup.up(db);

      expect((await setupRow()).completed_at).toBeInstanceOf(Date);
      expect((await seedAdmin()).hashed_password).toBe(SEED_HASH);
    });

    it("is complete when the seed admin no longer exists", async () => {
      await db.deleteFrom("users").where("email", "=", SEED_EMAIL).execute();
      await instanceSetup.up(db);

      expect((await setupRow()).completed_at).toBeInstanceOf(Date);
    });

    it.each([
      [
        "another user",
        () =>
          sql`INSERT INTO users (id, clinic_id, name, role, email, hashed_password)
              SELECT gen_random_uuid(), clinic_id, 'Nurse', 'provider', 'nurse@example.org', hashed_password
              FROM users WHERE email = ${SEED_EMAIL}`.execute(db),
      ],
      [
        "a soft-deleted user",
        () =>
          sql`INSERT INTO users (id, clinic_id, name, role, email, hashed_password, is_deleted)
              SELECT gen_random_uuid(), clinic_id, 'Gone', 'provider', 'gone@example.org', hashed_password, true
              FROM users WHERE email = ${SEED_EMAIL}`.execute(db),
      ],
      [
        "a patient",
        () =>
          sql`INSERT INTO patients (id, given_name) VALUES (gen_random_uuid(), 'Amina')`.execute(
            db,
          ),
      ],
      [
        "an event",
        () =>
          sql`INSERT INTO events (id, event_type) VALUES (gen_random_uuid(), 'note')`.execute(
            db,
          ),
      ],
    ])(
      "is complete when a recent seed admin sits beside %s",
      async (_, addData) => {
        await addData();
        await instanceSetup.up(db);

        expect((await setupRow()).completed_at).toBeInstanceOf(Date);
        expect((await seedAdmin()).hashed_password).toBe(SEED_HASH);
      },
    );

    it("leaves a rotated seed admin password untouched", async () => {
      await backdateSeedAdmin("30 days");
      await db
        .updateTable("users")
        .set({
          hashed_password:
            "$2b$10$rotatedrotatedrotatedrotatedrotatedrotatedrotatedrota",
        })
        .where("email", "=", SEED_EMAIL)
        .execute();
      await instanceSetup.up(db);

      expect((await seedAdmin()).hashed_password).toBe(
        "$2b$10$rotatedrotatedrotatedrotatedrotatedrotatedrotatedrota",
      );
    });
  });

  it("allows only a single instance_setup row", async () => {
    await instanceSetup.up(db);

    await expect(
      db.insertInto("instance_setup").values({ id: 2 }).execute(),
    ).rejects.toThrow();
    await expect(
      db.insertInto("instance_setup").values({ id: 1 }).execute(),
    ).rejects.toThrow();
  });

  describe("down", () => {
    it("restores the default password on an unfinished install", async () => {
      await instanceSetup.up(db);
      await instanceSetup.down(db);

      expect((await seedAdmin()).hashed_password).toBe(SEED_HASH);
      await expect(setupRow()).rejects.toThrow();
    });

    it("does not touch users on a completed install", async () => {
      await backdateSeedAdmin("400 days");
      await db
        .updateTable("users")
        .set({
          hashed_password:
            "$2b$10$rotatedrotatedrotatedrotatedrotatedrotatedrotatedrota",
        })
        .where("email", "=", SEED_EMAIL)
        .execute();
      await instanceSetup.up(db);
      await instanceSetup.down(db);

      expect((await seedAdmin()).hashed_password).toBe(
        "$2b$10$rotatedrotatedrotatedrotatedrotatedrotatedrotatedrota",
      );
    });
  });
});
