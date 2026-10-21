import { type Kysely, sql } from "kysely";
import { randomBytes } from "node:crypto";

/**
 * Migration: create_instance_setup
 * Created at: 2026-10-21
 * Description: Track first-run setup so new installs are claimed through /setup.
 * Depends on: 20260815_storage_backend_config_continuity
 *
 * Only a brand-new install is left pending, and its seed admin loses the
 * default password. Every existing deployment is marked complete, unchanged.
 */

const SEED_ADMIN_EMAIL = "admin@hikmahealth.org";
const SEED_ADMIN_HASH =
  "$2b$14$PPY9X2ZxFG93IU9CK4FUtOJW0d11zjHuODO6oJM5UNn59aXjp5h..";
const FRESH_INSTALL_WINDOW = "5 minutes";

const BCRYPT_ALPHABET =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A well-formed bcrypt hash of nothing: no password can ever match it. */
const unmatchableBcryptHash = (): string => {
  const body = Array.from(
    randomBytes(53),
    (byte) => BCRYPT_ALPHABET[byte % BCRYPT_ALPHABET.length],
  ).join("");
  return `$2b$14$${body}`;
};

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("instance_setup")
    .addColumn("id", "smallint", (col) => col.primaryKey().check(sql`id = 1`))
    // Plaintext on purpose: it exists only before any real data, and every
    // instance must print the same token.
    .addColumn("token", "text")
    .addColumn("completed_at", "timestamptz")
    .addColumn("completed_by", "uuid", (col) => col.references("users.id"))
    .addColumn("consent", "jsonb")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();

  // Soft-deleted rows count: any trace of real use means an existing deployment.
  const fresh = await sql<{ is_fresh: boolean }>`
    SELECT
      EXISTS (
        SELECT 1 FROM users
        WHERE email = ${SEED_ADMIN_EMAIL}
          AND created_at >= now() - ${FRESH_INSTALL_WINDOW}::interval
      )
      AND NOT EXISTS (SELECT 1 FROM users WHERE email <> ${SEED_ADMIN_EMAIL})
      AND NOT EXISTS (SELECT 1 FROM patients)
      AND NOT EXISTS (SELECT 1 FROM events)
      AS is_fresh
  `.execute(db);
  const isFreshInstall = fresh.rows[0]?.is_fresh === true;

  await db
    .insertInto("instance_setup")
    .values({ id: 1, completed_at: isFreshInstall ? null : sql`now()` })
    .execute();

  if (isFreshInstall) {
    await db
      .updateTable("users")
      .set({ hashed_password: unmatchableBcryptHash(), updated_at: sql`now()` })
      .where("email", "=", SEED_ADMIN_EMAIL)
      .execute();
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // An unfinished install goes back to the pre-setup state: the seed admin
  // with the default password. A finished one has no seed admin to restore.
  const pending = await db
    .selectFrom("instance_setup")
    .select("id")
    .where("completed_at", "is", null)
    .executeTakeFirst();

  if (pending) {
    await db
      .updateTable("users")
      .set({ hashed_password: SEED_ADMIN_HASH, updated_at: sql`now()` })
      .where("email", "=", SEED_ADMIN_EMAIL)
      .where("is_deleted", "=", false)
      .execute();
  }

  await db.schema.dropTable("instance_setup").execute();
}
