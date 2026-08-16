/**
 * The permanent guard against `schema.ts` and `migrations.ts` disagreeing.
 *
 * A fresh install runs CREATE TABLE from `schema.ts`; an upgrade replays
 * `migrations.ts`. Nothing makes those agree, and they silently drifted for
 * years — see `app/db/repairSchemaDrift.ts`. Fresh installs are unaffected by
 * every divergence below, which is why none of them show up in ordinary testing.
 *
 *   1. `schema.version` past the newest migration → `stepsForMigration` returns
 *      null → `_setUpWithSchema` → `unsafeDestroyEverything`. Every upgrading
 *      device is wiped, unsynced records included, behind one `logger.warn`.
 *   2. A table with no `createTable` step → upgraded devices lack it, so
 *      `collection.query()` throws and takes down the screen, not just sync.
 *   3. A column with no `addColumns` step → reads survive, but every INSERT
 *      names it and remote changes apply as one batch, so sync stops entirely.
 *   4. `repairSchemaDrift` drifting from the DDL WatermelonDB itself emits.
 *
 * This must outlive `repairSchemaDrift.ts`: removing that module means dropping
 * the two imports of it below and keeping `KNOWN_UNMIGRATABLE` as the sole list.
 */

import { addColumns } from "@nozbe/watermelondb/Schema/migrations"
import { encodeMigrationSteps } from "@nozbe/watermelondb/adapters/sqlite/encodeSchema"

import migrations from "@/db/migrations"
import { addColumnSql, DRIFTED_COLUMNS } from "@/db/repairSchemaDrift"
import schema from "@/db/schema"

type ColumnSchema = { name: string; type: string; isOptional?: boolean; isIndexed?: boolean }

type Step =
  | { type: "create_table"; schema: { name: string; columns: Record<string, ColumnSchema> } }
  | { type: "add_columns"; table: string; columns: ColumnSchema[] }
  | { type: string }

const appSchema = schema as unknown as {
  version: number
  tables: Record<string, { columns: Record<string, ColumnSchema> }>
}

const schemaMigrations = migrations as unknown as {
  minVersion: number
  maxVersion: number
  sortedMigrations: { toVersion: number; steps: Step[] }[]
}

/**
 * The drift that already shipped and deliberately cannot be migrated: SQLite has
 * no ADD COLUMN IF NOT EXISTS, so a `toVersion: 12` migration would fail with
 * "duplicate column name" on every device that fresh-installed.
 * `repairSchemaDrift` handles these at runtime instead.
 *
 * Nothing may be added here without the same analysis. New drift is a missing
 * migration, not an entry in this list.
 */
const KNOWN_UNMIGRATABLE: Readonly<Record<string, readonly string[]>> = {
  appointments: ["departments"],
  app_config: ["last_modified"],
  patient_problems: ["last_modified", "server_created_at"],
}

/**
 * Tables that existed before `migrations.ts` did, so "no createTable step" is
 * correct for them and only for them. Nothing may be added here — a new table
 * needs a `createTable`.
 */
const PRE_MIGRATION_TABLES = [
  "patients",
  "clinics",
  "users",
  "visits",
  "events",
  "event_forms",
  "registration_forms",
] as const

/**
 * The columns those seven tables carried at schema version 11. Their v1 shape is
 * recorded nowhere — history begins at schema version 8 — so the replay cannot
 * tell an original column from an added one, and the whole shape is pinned.
 *
 * Adding a column to one of these tables means adding a migration step for it.
 * Editing this list instead is how the `appointments.departments` incident
 * happens again; treat a diff here as a red flag.
 */
const PRE_MIGRATION_BASELINE: Readonly<Record<string, readonly string[]>> = {
  patients: [
    "given_name",
    "surname",
    "date_of_birth",
    "citizenship",
    "hometown",
    "phone",
    "sex",
    "camp",
    "additional_data",
    "metadata",
    "photo_url",
    "is_deleted",
    "deleted_at",
    "created_at",
    "updated_at",
    "government_id",
    "external_patient_id",
    "primary_clinic_id",
    "last_modified_by",
  ],
  clinics: [
    "name",
    "country",
    "city",
    "address",
    "updated_at",
    "created_at",
    "is_deleted",
    "deleted_at",
    "is_archived",
  ],
  users: [
    "clinic_id",
    "name",
    "role",
    "email",
    "created_at",
    "updated_at",
    "is_deleted",
    "deleted_at",
  ],
  visits: [
    "patient_id",
    "clinic_id",
    "provider_id",
    "provider_name",
    "check_in_timestamp",
    "metadata",
    "is_deleted",
    "deleted_at",
    "created_at",
    "updated_at",
  ],
  events: [
    "patient_id",
    "form_id",
    "visit_id",
    "event_type",
    "form_data",
    "metadata",
    "is_deleted",
    "deleted_at",
    "created_at",
    "updated_at",
    "recorded_by_user_id",
  ],
  event_forms: [
    "name",
    "description",
    "language",
    "is_editable",
    "is_snapshot_form",
    "form_fields",
    "metadata",
    "is_deleted",
    "deleted_at",
    "created_at",
    "updated_at",
    "clinic_ids",
    "translations",
  ],
  registration_forms: [
    "name",
    "fields",
    "metadata",
    "is_deleted",
    "deleted_at",
    "created_at",
    "updated_at",
  ],
}

/**
 * Replay every migration step, tracking the shape each table ends up with.
 *
 * `created` is tracked separately, and it is the whole correctness of the column
 * checks below: a table migrations only `addColumns` to accumulates just those
 * columns, so diffing it against `schema.ts` would report every original column
 * as missing. Those go through `PRE_MIGRATION_BASELINE` instead.
 */
function replayMigrations(): { shape: Map<string, Set<string>>; created: Set<string> } {
  const shape = new Map<string, Set<string>>()
  const created = new Set<string>()

  for (const migration of schemaMigrations.sortedMigrations) {
    for (const step of migration.steps) {
      if (step.type === "create_table") {
        const s = step as Extract<Step, { type: "create_table" }>
        shape.set(s.schema.name, new Set(Object.keys(s.schema.columns)))
        created.add(s.schema.name)
      } else if (step.type === "add_columns") {
        const s = step as Extract<Step, { type: "add_columns" }>
        const columns = shape.get(s.table) ?? new Set<string>()
        for (const column of s.columns) columns.add(column.name)
        shape.set(s.table, columns)
      }
    }
  }
  return { shape, created }
}

const { shape: replayed, created } = replayMigrations()

const declaredColumns = (table: string): string[] => Object.keys(appSchema.tables[table].columns)

const reachableColumns = (table: string): Set<string> => replayed.get(table) ?? new Set<string>()

describe("schema version is reachable by migration", () => {
  it("migrations cover the version schema.ts declares", () => {
    // A version past the newest migration resets the database rather than
    // failing, so the worst outcome's loudest symptom is a warning log.
    expect(schemaMigrations.maxVersion).toBe(appSchema.version)
  })

  it("migrations reach back to the first schema version ever shipped", () => {
    // `fromVersion < minVersion` wipes the same way, and deleting old migrations
    // to tidy up is what raises minVersion.
    expect(schemaMigrations.minVersion).toBe(1)
  })

  it("has no gaps between migration versions", () => {
    // WatermelonDB asserts this at import time, but only outside production —
    // in a release build the invariant is compiled out and the fallback is the
    // wipe.
    const versions = schemaMigrations.sortedMigrations.map((migration) => migration.toVersion)

    expect(versions).toEqual(versions.map((_, index) => index + 2))
  })
})

describe("every table in schema.ts can be built by migration", () => {
  it.each(Object.keys(appSchema.tables))(
    "%s is created by a migration or predates them",
    (table) => {
      // The column checks below only iterate tables migrations create, so a
      // forgotten one is skipped there rather than flagged.
      const buildable =
        created.has(table) ||
        PRE_MIGRATION_TABLES.includes(table as (typeof PRE_MIGRATION_TABLES)[number])

      expect(buildable).toBe(true)
    },
  )

  it("declares every table a migration creates", () => {
    // The reverse: a createTable for a table schema.ts dropped leaves upgraded
    // devices carrying one fresh installs do not have.
    const undeclared = [...created].filter((table) => !appSchema.tables[table])

    expect(undeclared).toEqual([])
  })

  it("PRE_MIGRATION_TABLES names only tables that really predate migrations", () => {
    // Stops the escape hatch from being widened. A listed table a migration does
    // create is stale; one schema.ts no longer declares hides a future gap.
    const wrong = PRE_MIGRATION_TABLES.filter(
      (table) => created.has(table) || !appSchema.tables[table],
    )

    expect(wrong).toEqual([])
  })
})

describe("migrations reproduce schema.ts", () => {
  const migrationCreated = [...created].filter((table) => appSchema.tables[table])

  it("has tables to check", () => {
    // A refactor that broke `sortedMigrations` would otherwise make every
    // assertion below vacuously pass.
    expect(migrationCreated.length).toBeGreaterThan(10)
  })

  it.each(migrationCreated)("%s: every schema column is reachable by migration", (table) => {
    const reachable = reachableColumns(table)
    const allowed = KNOWN_UNMIGRATABLE[table] ?? []
    const missing = declaredColumns(table).filter(
      (column) => !reachable.has(column) && !allowed.includes(column),
    )

    expect(missing).toEqual([])
  })

  it.each(migrationCreated)("%s: migrations add nothing schema.ts lacks", (table) => {
    const declared = declaredColumns(table)
    const extra = [...reachableColumns(table)].filter((column) => !declared.includes(column))

    expect(extra).toEqual([])
  })

  it("the known-unmigratable list is exactly the drift that exists", () => {
    // Stops the allow-list outliving the problem: migrate one of these and this
    // fails until the entry is deleted.
    const stillDrifted: Record<string, string[]> = {}
    for (const [table, columns] of Object.entries(KNOWN_UNMIGRATABLE)) {
      const reachable = reachableColumns(table)
      const drifted = columns.filter((column) => !reachable.has(column))
      if (drifted.length > 0) stillDrifted[table] = drifted
    }

    expect(stillDrifted).toEqual(KNOWN_UNMIGRATABLE)
  })

  it("every allow-listed column is still declared in schema.ts", () => {
    // The assertion above cannot see a removal: drop a column from schema.ts and
    // it stays absent from the replay, looking like drift forever while
    // `repairSchemaDrift` goes on adding a column nothing writes to.
    const undeclared = Object.entries(KNOWN_UNMIGRATABLE).flatMap(([table, columns]) =>
      columns.filter((column) => !declaredColumns(table).includes(column)),
    )

    expect(undeclared).toEqual([])
  })

  it("matches the list the runtime repair actually acts on", () => {
    // `KNOWN_UNMIGRATABLE` is duplicated rather than imported so the two are
    // derived independently and cross-check each other. That only earns its
    // keep if something notices when they diverge.
    expect(DRIFTED_COLUMNS).toEqual(KNOWN_UNMIGRATABLE)
  })
})

describe("pre-migration tables gain no column without a migration", () => {
  it.each(PRE_MIGRATION_TABLES)("%s: every column is baselined or migrated", (table) => {
    const reachable = reachableColumns(table)
    const baseline = PRE_MIGRATION_BASELINE[table] ?? []
    const unexplained = declaredColumns(table).filter(
      (column) => !reachable.has(column) && !baseline.includes(column),
    )

    // A column here means schema.ts gained it with no `addColumns` step — the
    // same incident, on the largest and most write-heavy tables in the app.
    expect(unexplained).toEqual([])
  })

  it.each(PRE_MIGRATION_TABLES)("%s: the baseline has not rotted", (table) => {
    // A column dropped from schema.ts but left here widens the allow-list above,
    // so it would stop catching a re-added column.
    const stale = (PRE_MIGRATION_BASELINE[table] ?? []).filter(
      (column) => !appSchema.tables[table].columns[column],
    )

    expect(stale).toEqual([])
  })
})

describe("repairSchemaDrift emits what WatermelonDB itself would emit", () => {
  const drifted = Object.entries(DRIFTED_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => ({ table, column, schema: appSchema.tables[table].columns[column] })),
  )

  const upstreamDdl = (table: string, column: ColumnSchema): string =>
    encodeMigrationSteps([addColumns({ table, columns: [column] as never })])

  it.each(drifted)(
    "$table.$column: the ALTER matches upstream's",
    ({ table, column, schema: columnSchema }) => {
      // Pinned against WatermelonDB's own encoder, so an upstream change to
      // quoting, types, or constraints fails here rather than shipping repaired
      // tables that differ from migrated ones.
      const [upstreamAlter] = upstreamDdl(table, columnSchema).split(";")

      expect(upstreamAlter).toBe(addColumnSql(table, column))
    },
  )

  it.each(drifted)("$table.$column: needs no index", ({ table, schema: columnSchema }) => {
    // `addColumns` also emits `create index if not exists` for an indexed
    // column, which the repair does not, so a drifted column with `isIndexed`
    // would be shaped right but queried differently from a fresh install's.
    expect(columnSchema.isIndexed ?? false).toBe(false)
    expect(upstreamDdl(table, columnSchema)).not.toContain("create index")
  })

  // Remove `.failing` once the repair backfills.
  //
  // `addColumns` emits the ALTER *and* `update "t" set "c" = <nullValue(col)>` —
  // '' for a non-optional string, 0 for a number — and all four drifted columns
  // are non-optional, so a migrated device gets a typed default where a repaired
  // one gets NULL. Rows almost certainly do not exist on the affected devices,
  // since the drift is what made every INSERT fail, but that rests on squashed
  // history nobody can read.
  it.failing.each(drifted)(
    "$table.$column: backfills existing rows",
    ({ table, column, schema: columnSchema }) => {
      expect(`${addColumnSql(table, column)};`).toBe(upstreamDdl(table, columnSchema))
    },
  )
})
