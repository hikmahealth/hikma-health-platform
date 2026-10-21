import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "@/db";
import { afterAll } from "vitest";

// ISO 27799 §8.31: no fallback to DATABASE_URL, which may hold real patient data.
const testDbUrl = process.env.TEST_DATABASE_URL;

if (!testDbUrl) {
  throw new Error(
    "TEST_DATABASE_URL must be set for integration tests (a dedicated test database).",
  );
}

// database/config.ts only honours TEST_DATABASE_URL under NODE_ENV=test.
if (process.env.NODE_ENV !== "test") {
  throw new Error(
    `NODE_ENV must be "test" for integration tests (got "${process.env.NODE_ENV}").`,
  );
}

if (
  testDbUrl === process.env.DATABASE_URL &&
  process.env.ALLOW_SHARED_TEST_DATABASE !== "true"
) {
  throw new Error(
    "TEST_DATABASE_URL is the same database as DATABASE_URL. If that database " +
      "holds no real patient data, set ALLOW_SHARED_TEST_DATABASE=true.",
  );
}

export const testDb = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: testDbUrl }),
  }),
});

afterAll(async () => {
  await testDb.destroy();
});
