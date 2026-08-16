/**
 * Adds columns `schema.ts` declares that no migration ever creates.
 *
 * Prepared statements are built from the schema, not the migrations, so on a
 * device that upgraded rather than fresh-installed every INSERT names a column
 * SQLite lacks — and remote changes apply as one batch, so those devices sync
 * nothing at all.
 *
 * This cannot be a migration: `addColumns` emits a bare `alter table … add …`,
 * SQLite has no ADD COLUMN IF NOT EXISTS, and it would fail with "duplicate
 * column name" on every fresh install. Repairing correctly means reading the
 * real table shape at runtime.
 *
 * REMOVAL PLAN — only devices that installed at schema version < 3
 * (`appointments`) or < 5 (the rest) are affected, so the population drains on
 * its own. Sentry fires only when a column is actually added; when those events
 * stop, delete this module, its three call sites, and the two imports of it in
 * `test/db/schema-migration-parity.test.ts` — the permanent guard, which must
 * outlive this file.
 */

import { Q } from "@nozbe/watermelondb"
import * as Sentry from "@sentry/react-native"
import { Logger } from "@hikmahealth/js-utils"

/**
 * Columns in `schema.ts` that no migration step ever adds.
 * `schema-migration-parity.test.ts` re-derives this from a migration replay, so
 * it cannot silently fall out of date.
 */
export const DRIFTED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  appointments: ["departments"],
  app_config: ["last_modified"],
  patient_problems: ["last_modified", "server_created_at"],
}

/**
 * Set once the repair completes, so the pragma reads happen on one cold start
 * rather than all of them. A future repair uses a new key.
 */
const REPAIR_MARKER_KEY = "hh/schema-drift-repair/v1"

/**
 * SQLite cannot bind identifiers, so names are concatenated into DDL. They are
 * all compile-time constants today; this keeps that true if that ever changes.
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]*$/

/** The promise-returning adapter surface this needs (`database.adapter`). */
export type RawSqlAdapter = {
  unsafeQueryRaw: (query: unknown) => Promise<unknown[]>
  unsafeExecute: (work: { sqls: [string, unknown[]][] }) => Promise<void>
  getLocal: (key: string) => Promise<string | undefined>
  setLocal: (key: string, value: string) => Promise<void>
}

function assertSafeIdentifier(name: string, kind: "table" | "column"): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`[schema-repair] unsafe ${kind} identifier: ${JSON.stringify(name)}`)
  }
}

/**
 * The ALTER for one column, shaped like the CREATE TABLE a fresh install runs.
 * Typeless and constraint-free on purpose: SQLite tests a NOT NULL or CHECK on
 * ADD COLUMN against every existing row.
 *
 * @internal exported for unit testing
 */
export function addColumnSql(table: string, column: string): string {
  assertSafeIdentifier(table, "table")
  assertSafeIdentifier(column, "column")
  return `alter table "${table}" add "${column}"`
}

/**
 * Column names out of a `pragma table_info(...)` result. A malformed row costs a
 * redundant ALTER attempt rather than the whole repair.
 *
 * @internal exported for unit testing
 */
export function columnNamesFromTableInfo(rows: ReadonlyArray<unknown>): string[] {
  return rows.flatMap((row) =>
    typeof row === "object" && row !== null && typeof (row as { name?: unknown }).name === "string"
      ? [(row as { name: string }).name]
      : [],
  )
}

/**
 * The ALTER statements this device needs. A table reporting no columns does not
 * exist here and is skipped — `alter table` on a missing one aborts the batch.
 *
 * @internal exported for unit testing
 */
export function planRepair(
  actualColumns: Readonly<Record<string, readonly string[]>>,
  wanted: Readonly<Record<string, readonly string[]>> = DRIFTED_COLUMNS,
): { table: string; column: string; sql: string }[] {
  return Object.entries(wanted).flatMap(([table, columns]) => {
    const present = actualColumns[table]
    if (!present || present.length === 0) return []
    return columns
      .filter((column) => !present.includes(column))
      .map((column) => ({ table, column, sql: addColumnSql(table, column) }))
  })
}

async function readColumns(adapter: RawSqlAdapter, table: string): Promise<string[]> {
  assertSafeIdentifier(table, "table")
  const rows = await adapter.unsafeQueryRaw({
    table,
    description: Q.buildQueryDescription([Q.unsafeSqlQuery(`pragma table_info("${table}")`)]),
    associations: [],
  })
  return columnNamesFromTableInfo(rows)
}

/**
 * Reconcile the device's tables against `DRIFTED_COLUMNS`. Idempotent, and a
 * pure read on a healthy device.
 *
 * Never rejects — callers gate real work on this, so a rejection would escalate
 * "broken sync on a small old population" into a hang everywhere. On failure the
 * marker is left unset and the next cold start retries.
 */
export async function repairSchemaDrift(adapter: RawSqlAdapter): Promise<void> {
  try {
    if (await adapter.getLocal(REPAIR_MARKER_KEY)) return

    const actualColumns: Record<string, string[]> = {}
    for (const table of Object.keys(DRIFTED_COLUMNS)) {
      actualColumns[table] = await readColumns(adapter, table)
    }

    // These tables are all created by migration v3/v5, so an absent one means
    // the read happened at the wrong time, not that there is nothing to do. The
    // marker is permanent, so bail rather than certify an uninspectable device.
    const absentTables = Object.keys(DRIFTED_COLUMNS).filter(
      (table) => actualColumns[table].length === 0,
    )
    if (absentTables.length > 0) {
      Logger.warn({
        msg: "[schema-repair] target tables absent; not marking this device repaired",
        data: { absentTables },
      })
      return
    }

    const plan = planRepair(actualColumns)
    if (plan.length > 0) {
      await adapter.unsafeExecute({
        sqls: plan.map((step) => [step.sql, []] as [string, unknown[]]),
      })

      // The marker below permanently stops this running again, so confirm
      // against the table rather than trust `unsafeExecute` to reject on failed
      // DDL — this holds however the adapter reports failure.
      for (const table of Object.keys(DRIFTED_COLUMNS)) {
        actualColumns[table] = await readColumns(adapter, table)
      }
      const stillMissing = planRepair(actualColumns)
      if (stillMissing.length > 0) {
        throw new Error(
          `[schema-repair] columns still absent after ALTER: ${stillMissing
            .map((step) => `${step.table}.${step.column}`)
            .join(", ")}`,
        )
      }

      // Schema metadata only — no row contents reach Sentry from here.
      const repaired = plan.map((step) => `${step.table}.${step.column}`)
      Logger.warn({
        msg: "[schema-repair] added columns missing on this device",
        data: { repaired },
      })
      Sentry.captureMessage("[schema-repair] added columns missing on this device", {
        level: "warning",
        extra: { repaired },
      })
    }

    // Last, and only on a verified-clean device: a marker written over a table
    // that is still wrong would strand that device permanently.
    await adapter.setLocal(REPAIR_MARKER_KEY, new Date().toISOString())
  } catch (error) {
    Logger.error({ msg: "[schema-repair] failed; leaving the device as it was", err: error })
    Sentry.captureException(error, {
      level: "error",
      extra: { message: "[schema-repair] failed" },
    })
  }
}
