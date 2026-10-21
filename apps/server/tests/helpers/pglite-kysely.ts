import { PGlite } from "@electric-sql/pglite";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FileMigrationProvider,
  Kysely,
  Migrator,
  PostgresDialect,
  type PostgresPoolClient,
} from "kysely";

const commandOf = (statement: string): string =>
  statement.trimStart().split(/\s+/, 1)[0]?.toUpperCase() ?? "";

export type Pglite = {
  db: Kysely<any>;
  /** Runs SQL on the session directly, without waiting for the pool. */
  query: (statement: string, parameters?: unknown[]) => Promise<unknown>;
};

/**
 * In-memory Postgres behind Kysely, acting as a pool of one. `query` skips the
 * pool, e.g. to simulate another instance writing mid-transaction.
 */
export const createPglite = (): Pglite => {
  const pglite = new PGlite();
  let released: Promise<void> = Promise.resolve();
  let release = () => {};

  const query = async (statement: string, parameters: unknown[] = []) => {
    await pglite.waitReady;
    return pglite.query(statement, parameters);
  };

  const client = {
    query: async (statement: string, parameters: readonly unknown[]) => {
      const result = await query(statement, [...parameters]);
      return {
        command: commandOf(statement),
        rowCount: result.affectedRows ?? result.rows.length,
        rows: result.rows,
      };
    },
    release: () => release(),
  };

  const connect = async () => {
    const previous = released;
    let free = () => {};
    released = new Promise<void>((resolve) => {
      free = resolve;
    });
    await previous;
    release = free;
    return client;
  };

  const db = new Kysely<any>({
    dialect: new PostgresDialect({
      pool: {
        // Kysely only uses the cursor overload for streaming, which these tests never do.
        connect: connect as () => Promise<PostgresPoolClient>,
        end: () => pglite.close(),
      },
    }),
  });

  return { db, query };
};

export const createPgliteKysely = (): Kysely<any> => createPglite().db;

const MIGRATIONS_FOLDER = path.resolve(
  __dirname,
  "../../../../database/migrations",
);

/** Runs every migration in `database/migrations`, as a fresh deploy would. */
export const migrateToLatest = async (db: Kysely<any>): Promise<void> => {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATIONS_FOLDER,
    }),
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
};
