import type { Kysely } from "kysely";
import type { DB } from "@hikmahealth/database/types/schema/hh";

export const SEED_ADMIN_EMAIL = "admin@hikmahealth.org";

/** The hash every install was seeded with, by database/migrations/20191126_initial_user.ts. */
export const SEED_ADMIN_HASH =
  "$2b$14$PPY9X2ZxFG93IU9CK4FUtOJW0d11zjHuODO6oJM5UNn59aXjp5h..";

export type DefaultCredentialStatus =
  { kind: "in-use"; userId: string } | { kind: "not-in-use" };

/** Whether the seeded admin still has the default password. Any change re-salts, so comparing hashes is exact. */
export const getDefaultCredentialStatus = async (
  db: Kysely<DB>,
): Promise<DefaultCredentialStatus> => {
  const seed = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", SEED_ADMIN_EMAIL)
    .where("hashed_password", "=", SEED_ADMIN_HASH)
    .where("is_deleted", "=", false)
    .executeTakeFirst();
  return seed ? { kind: "in-use", userId: seed.id } : { kind: "not-in-use" };
};
