/**
 * The I/O half of `repairSchemaDrift`: "never rejects", and "the marker is only
 * written over a verified-clean device". The marker is permanent, so one
 * written over a still-broken table strands that device forever.
 *
 * The sibling test calls this half untestable under LokiJS, but
 * `repairSchemaDrift` takes a `RawSqlAdapter` as a parameter. The fake below is
 * deliberately hostile: it rejects DDL it cannot parse and rolls the whole
 * batch back on a duplicate column, as SQLite and WatermelonDB's `batch` do.
 */

import * as Sentry from "@sentry/react-native"

import { DRIFTED_COLUMNS, repairSchemaDrift, type RawSqlAdapter } from "@/db/repairSchemaDrift"

jest.mock("@sentry/react-native", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}))

jest.mock("@hikmahealth/js-utils", () => ({
  Logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

const captureMessage = Sentry.captureMessage as jest.Mock
const captureException = Sentry.captureException as jest.Mock

/** Every column the four drifted ones sit next to, minus the drift itself. */
const BASE_COLUMNS: Record<string, string[]> = {
  appointments: ["id", "_status", "_changed", "patient_id", "reason", "status"],
  app_config: ["id", "_status", "_changed", "namespace", "key", "value"],
  patient_problems: ["id", "_status", "_changed", "patient_id", "problem_code"],
}

const healthyColumns = (): Record<string, string[]> => ({
  appointments: [...BASE_COLUMNS.appointments, "departments"],
  app_config: [...BASE_COLUMNS.app_config, "last_modified"],
  patient_problems: [...BASE_COLUMNS.patient_problems, "last_modified", "server_created_at"],
})

const driftedColumns = (): Record<string, string[]> => ({
  appointments: [...BASE_COLUMNS.appointments],
  app_config: [...BASE_COLUMNS.app_config],
  patient_problems: [...BASE_COLUMNS.patient_problems],
})

const ALTER = /^alter table "([a-z][a-z0-9_]*)" add "([a-z][a-z0-9_]*)"$/

type FakeOptions = {
  columns: Record<string, string[]>
  local?: Map<string, string>
  /**
   * Whether the batch takes effect. WatermelonDB wraps it in one transaction
   * (`Database-batch.cpp:62,110`), so it is all or nothing. `false` models DDL
   * that resolves without applying — what the post-ALTER check exists to catch.
   */
  applies?: boolean
  rejects?: Partial<Record<"unsafeQueryRaw" | "unsafeExecute" | "getLocal" | "setLocal", Error>>
}

type Fake = RawSqlAdapter & {
  columns: Record<string, string[]>
  local: Map<string, string>
  calls: string[]
  pragmaReads: string[]
  executed: string[][]
}

function makeFake(options: FakeOptions): Fake {
  const columns = Object.fromEntries(
    Object.entries(options.columns).map(([table, cols]) => [table, [...cols]]),
  )
  const local = options.local ?? new Map<string, string>()
  const applies = options.applies ?? true
  const rejects = options.rejects ?? {}
  const calls: string[] = []
  const pragmaReads: string[] = []
  const executed: string[][] = []

  const fake: Fake = {
    columns,
    local,
    calls,
    pragmaReads,
    executed,

    async unsafeQueryRaw(query: unknown) {
      if (rejects.unsafeQueryRaw) throw rejects.unsafeQueryRaw
      const table = (query as { table: string }).table
      const sql = (query as { description: { sql?: { sql: string } } }).description.sql?.sql
      // Pinned so a rewrite that stops asking SQLite for the real table shape —
      // and starts trusting `schema.ts` again — fails here.
      expect(sql).toBe(`pragma table_info("${table}")`)
      calls.push(`read:${table}`)
      pragmaReads.push(table)
      return (columns[table] ?? []).map((name, cid) => ({ cid, name, type: "" }))
    },

    async unsafeExecute(work: { sqls: [string, unknown[]][] }) {
      const statements = work.sqls.map(([sql]) => sql)
      calls.push(`exec:${statements.length}`)
      executed.push(statements)
      if (rejects.unsafeExecute) throw rejects.unsafeExecute

      // SQLite runs a WatermelonDB batch in one transaction, so a statement
      // that fails takes every statement in the batch with it.
      const staged = Object.fromEntries(
        Object.entries(columns).map(([table, cols]) => [table, [...cols]]),
      )
      work.sqls.forEach(([sql, args]) => {
        const match = ALTER.exec(sql)
        if (!match) throw new Error(`fake adapter cannot parse DDL: ${sql}`)
        expect(args).toEqual([])
        const [, table, column] = match
        if (!staged[table]) throw new Error(`no such table: ${table}`)
        if (staged[table].includes(column)) throw new Error(`duplicate column name: ${column}`)
        if (applies) staged[table].push(column)
      })
      for (const [table, cols] of Object.entries(staged)) columns[table] = cols
    },

    async getLocal(key: string) {
      if (rejects.getLocal) throw rejects.getLocal
      calls.push(`getLocal:${key}`)
      return local.get(key)
    },

    async setLocal(key: string, value: string) {
      calls.push(`setLocal:${key}`)
      if (rejects.setLocal) throw rejects.setLocal
      local.set(key, value)
    },
  }

  return fake
}

const markerOf = (fake: Fake): string | undefined => [...fake.local.keys()][0]

const markerWritten = (fake: Fake): boolean => fake.local.size > 0

/** Module-private on purpose, so it is discovered the way a device produces it. */
let MARKER_KEY: string
beforeAll(async () => {
  const probe = makeFake({ columns: healthyColumns() })
  await repairSchemaDrift(probe)
  MARKER_KEY = markerOf(probe) as string
  expect(MARKER_KEY).toEqual(expect.any(String))
})

beforeEach(() => {
  captureMessage.mockClear()
  captureException.mockClear()
})

describe("a device that has already been repaired", () => {
  it("touches nothing at all", async () => {
    const fake = makeFake({
      columns: driftedColumns(),
      local: new Map([[MARKER_KEY, "2026-08-01T00:00:00.000Z"]]),
    })

    await repairSchemaDrift(fake)

    // The marker exists to keep three pragma reads off every cold start; a
    // rewrite that reads first and checks second silently loses that.
    expect(fake.pragmaReads).toEqual([])
    expect(fake.executed).toEqual([])
    expect(fake.columns).toEqual(driftedColumns())
  })

  it("does not rewrite the marker", async () => {
    // Rewriting it each launch would keep resetting the timestamp that the
    // removal plan reads as "when did this device last need repairing".
    const local = new Map([[MARKER_KEY, "2026-08-01T00:00:00.000Z"]])
    const fake = makeFake({ columns: healthyColumns(), local })

    await repairSchemaDrift(fake)

    expect(local.get(MARKER_KEY)).toBe("2026-08-01T00:00:00.000Z")
  })
})

describe("a healthy device", () => {
  it("is a pure read, then a mark", async () => {
    const fake = makeFake({ columns: healthyColumns() })

    await repairSchemaDrift(fake)

    expect(fake.pragmaReads.sort()).toEqual(Object.keys(DRIFTED_COLUMNS).sort())
    expect(fake.executed).toEqual([])
    expect(markerWritten(fake)).toBe(true)
  })

  it("reports nothing to Sentry", async () => {
    // The removal plan is "delete this when the Sentry events stop", so a
    // healthy device that reports anything keeps the module immortal.
    await repairSchemaDrift(makeFake({ columns: healthyColumns() }))

    expect(captureMessage).not.toHaveBeenCalled()
    expect(captureException).not.toHaveBeenCalled()
  })
})

describe("a drifted device", () => {
  it("adds exactly the missing columns", async () => {
    const fake = makeFake({ columns: driftedColumns() })

    await repairSchemaDrift(fake)

    expect(fake.executed).toEqual([
      [
        'alter table "appointments" add "departments"',
        'alter table "app_config" add "last_modified"',
        'alter table "patient_problems" add "last_modified"',
        'alter table "patient_problems" add "server_created_at"',
      ],
    ])
    expect(fake.columns).toEqual(healthyColumns())
    expect(markerWritten(fake)).toBe(true)
  })

  it("sends the whole repair as one batch", async () => {
    // One `unsafeExecute` is one transaction. Splitting it would let a device
    // end up half-repaired with no record of which half.
    const fake = makeFake({ columns: driftedColumns() })

    await repairSchemaDrift(fake)

    expect(fake.calls.filter((call) => call.startsWith("exec:"))).toEqual(["exec:4"])
  })

  it("re-reads the tables before writing the marker", async () => {
    const fake = makeFake({ columns: driftedColumns() })

    await repairSchemaDrift(fake)

    const exec = fake.calls.indexOf("exec:4")
    const mark = fake.calls.indexOf(`setLocal:${MARKER_KEY}`)
    const readsAfterExec = fake.calls.slice(exec, mark).filter((c) => c.startsWith("read:"))

    // The marker is permanent, so it must never be written on the strength of
    // `unsafeExecute` resolving. Three verification reads have to sit between.
    expect(exec).toBeGreaterThan(-1)
    expect(mark).toBeGreaterThan(exec)
    expect(readsAfterExec.sort()).toEqual(
      Object.keys(DRIFTED_COLUMNS)
        .map((t) => `read:${t}`)
        .sort(),
    )
  })

  it("repairs a device missing only one column", async () => {
    const columns = healthyColumns()
    columns.patient_problems = columns.patient_problems.filter((c) => c !== "server_created_at")
    const fake = makeFake({ columns })

    await repairSchemaDrift(fake)

    expect(fake.executed).toEqual([['alter table "patient_problems" add "server_created_at"']])
    expect(fake.columns).toEqual(healthyColumns())
  })

  it("reports the repair to Sentry with schema names only", async () => {
    const fake = makeFake({ columns: driftedColumns() })

    await repairSchemaDrift(fake)

    expect(captureMessage).toHaveBeenCalledTimes(1)
    const [, options] = captureMessage.mock.calls[0]
    // Sentry is not a BAA-covered destination for row contents. Every value
    // here has to be a `table.column` name out of `DRIFTED_COLUMNS`.
    expect(options.extra.repaired).toEqual([
      "appointments.departments",
      "app_config.last_modified",
      "patient_problems.last_modified",
      "patient_problems.server_created_at",
    ])
    // Nothing but names may ride along: no row, no id, no free-text column
    // value. Anything outside the `DRIFTED_COLUMNS` cross-product is new data.
    const allowed = Object.entries(DRIFTED_COLUMNS).flatMap(([table, columns]) =>
      columns.map((column) => `${table}.${column}`),
    )
    expect(Object.keys(options)).toEqual(["level", "extra"])
    expect(Object.keys(options.extra)).toEqual(["repaired"])
    expect(allowed).toEqual(expect.arrayContaining(options.extra.repaired))
    expect(captureException).not.toHaveBeenCalled()
  })

  it("is idempotent when the marker is lost between runs", async () => {
    // A restore-from-backup re-runs the repair over an already-fixed table, and
    // `alter table … add` on an existing column errors, so plan nothing.
    const fake = makeFake({ columns: driftedColumns() })
    await repairSchemaDrift(fake)
    fake.local.clear()
    fake.executed.length = 0

    await repairSchemaDrift(fake)

    expect(fake.executed).toEqual([])
    expect(markerWritten(fake)).toBe(true)
  })
})

describe("the marker is withheld from any device it cannot certify", () => {
  it("withholds it when an ALTER resolves without applying", async () => {
    const fake = makeFake({ columns: driftedColumns(), applies: false })

    await repairSchemaDrift(fake)

    // Why the post-ALTER verification exists: an adapter that reports success
    // without doing the work would earn a permanent marker over a broken device.
    expect(markerWritten(fake)).toBe(false)
    expect(captureException).toHaveBeenCalledTimes(1)
    // The report has to name what is still wrong. A bare "repair failed" leaves
    // the next reader unable to tell an un-applied ALTER from a locked database.
    expect(String(captureException.mock.calls[0][0])).toContain(
      "appointments.departments, app_config.last_modified, " +
        "patient_problems.last_modified, patient_problems.server_created_at",
    )
  })

  it.each(Object.keys(DRIFTED_COLUMNS))("withholds it when %s is absent", async (absent) => {
    const columns = driftedColumns()
    columns[absent] = []
    const fake = makeFake({ columns })

    await repairSchemaDrift(fake)

    // `alter table` on a missing table aborts the batch, so an absent table
    // means the read happened at the wrong time. Marking would certify nothing.
    expect(fake.executed).toEqual([])
    expect(markerWritten(fake)).toBe(false)
  })

  it("withholds it when every table is absent", async () => {
    const fake = makeFake({ columns: { appointments: [], app_config: [], patient_problems: [] } })

    await repairSchemaDrift(fake)

    expect(markerWritten(fake)).toBe(false)
  })

  it.each([
    ["unsafeExecute", { unsafeExecute: new Error("disk I/O error") }],
    ["unsafeQueryRaw", { unsafeQueryRaw: new Error("database is locked") }],
    ["setLocal", { setLocal: new Error("database or disk is full") }],
  ] as const)("withholds it when %s fails", async (_name, rejects) => {
    const fake = makeFake({ columns: driftedColumns(), rejects })

    await expect(repairSchemaDrift(fake)).resolves.toBeUndefined()

    expect(markerWritten(fake)).toBe(false)
    expect(captureException).toHaveBeenCalledTimes(1)
  })
})

describe("it never rejects", () => {
  // Three sync paths gate real work on this promise. A rejection would escalate
  // "sync is broken on a small old population" into a hang for everyone.
  it.each([
    ["getLocal", { getLocal: new Error("no such table: local_storage") }],
    ["unsafeQueryRaw", { unsafeQueryRaw: new Error("database is locked") }],
    ["unsafeExecute", { unsafeExecute: new Error("disk I/O error") }],
    ["setLocal", { setLocal: new Error("database or disk is full") }],
  ] as const)("swallows a rejection from %s", async (_name, rejects) => {
    await expect(
      repairSchemaDrift(makeFake({ columns: driftedColumns(), rejects })),
    ).resolves.toBeUndefined()
  })

  it("swallows an adapter that throws synchronously", async () => {
    const hostile = {
      getLocal: () => {
        throw new Error("adapter is not initialised")
      },
    } as unknown as RawSqlAdapter

    await expect(repairSchemaDrift(hostile)).resolves.toBeUndefined()
  })

  it("swallows a pragma result that is not an array", async () => {
    const hostile = makeFake({ columns: driftedColumns() })
    hostile.unsafeQueryRaw = async () => null as unknown as unknown[]

    await expect(repairSchemaDrift(hostile)).resolves.toBeUndefined()
    expect(markerWritten(hostile)).toBe(false)
  })

  it("tolerates malformed pragma rows without altering an existing column", async () => {
    // `columnNamesFromTableInfo` drops a row whose `name` is not a string. Its
    // docstring calls that "a redundant ALTER" — but that is `duplicate column
    // name`, which aborts the transaction. The device is left alone and unmarked.
    const fake = makeFake({ columns: healthyColumns() })
    const realRead = fake.unsafeQueryRaw
    fake.unsafeQueryRaw = async (query: unknown) => {
      const rows = (await realRead(query)) as { name: string }[]
      return rows.map((row) =>
        row.name === "departments" ? { cid: 99, name: null } : row,
      ) as unknown[]
    }

    await expect(repairSchemaDrift(fake)).resolves.toBeUndefined()

    expect(fake.columns).toEqual(healthyColumns())
    expect(markerWritten(fake)).toBe(false)
  })
})

describe("the repair marker key", () => {
  /**
   * Nothing couples `REPAIR_MARKER_KEY` to `DRIFTED_COLUMNS`. Adding a column
   * without bumping the key is a silent no-op on every device that already
   * wrote the current key — the "sync stops and nobody notices" incident this
   * module exists to fix.
   *
   * Each entry pins one version of the list to the key that repairs it.
   */
  const KEY_FOR_LIST: Readonly<Record<string, string>> = {
    '[["app_config",["last_modified"]],["appointments",["departments"]],["patient_problems",["last_modified","server_created_at"]]]':
      "hh/schema-drift-repair/v1",
  }

  const fingerprint = (list: Readonly<Record<string, readonly string[]>>): string =>
    JSON.stringify(
      Object.entries(list)
        .map(([table, columns]) => [table, [...columns].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    )

  it("is bumped whenever DRIFTED_COLUMNS changes", () => {
    const current = fingerprint(DRIFTED_COLUMNS)

    expect(Object.keys(KEY_FOR_LIST)).toContain(current)
    expect(MARKER_KEY).toBe(KEY_FOR_LIST[current])
  })

  it("is namespaced and versioned", () => {
    expect(MARKER_KEY).toMatch(/^hh\/schema-drift-repair\/v\d+$/)
  })
})

describe("the absent-table bail is observable", () => {
  // Remove `.failing` once the bail reports.
  //
  // `Logger.warn` is a no-op in production and the bail reaches no Sentry call,
  // so a device that bails every cold start emits nothing — and the removal
  // plan reads that silence as "the population drained".
  it.failing("reports a device it could not inspect", async () => {
    const columns = driftedColumns()
    columns.app_config = []

    await repairSchemaDrift(makeFake({ columns }))

    expect(captureMessage.mock.calls.length + captureException.mock.calls.length).toBe(1)
  })
})
