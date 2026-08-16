/**
 * Covers the pure half of `repairSchemaDrift` — deciding which ALTER statements
 * a device needs.
 *
 * The I/O half cannot run here: tests use LokiJS, which has no raw SQL, so
 * `unsafeQueryRaw`/`unsafeExecute` have nothing to talk to. It is validated on a
 * simulator against a deliberately-broken database instead, and the module is
 * split the way it is so the decision logic is testable without one.
 */

import {
  addColumnSql,
  columnNamesFromTableInfo,
  DRIFTED_COLUMNS,
  planRepair,
} from "@/db/repairSchemaDrift"

describe("addColumnSql", () => {
  it("emits the statement addColumns would have produced", () => {
    // Typeless and constraint-free on purpose: SQLite tests a NOT NULL or CHECK
    // on ADD COLUMN against every existing row.
    expect(addColumnSql("appointments", "departments")).toBe(
      'alter table "appointments" add "departments"',
    )
  })

  it.each([
    ['appointments"; drop table patients; --', "departments"],
    ["appointments", 'departments"; drop table patients; --'],
    ["Appointments", "departments"],
    ["", "departments"],
    ["appointments", ""],
    ["1appointments", "departments"],
  ])("refuses to build DDL for (%s, %s)", (table, column) => {
    // Identifiers cannot be bound in SQLite, so they are concatenated. Today
    // they are compile-time constants; this keeps that safe if a dynamic source
    // is ever wired in.
    expect(() => addColumnSql(table, column)).toThrow(/unsafe (table|column) identifier/)
  })
})

describe("columnNamesFromTableInfo", () => {
  it("reads names out of a pragma result", () => {
    expect(
      columnNamesFromTableInfo([
        { cid: 0, name: "id", type: "varchar" },
        { cid: 1, name: "reason", type: "varchar" },
      ]),
    ).toEqual(["id", "reason"])
  })

  it("skips malformed rows rather than throwing", () => {
    // A bad row should cost a redundant ALTER attempt, not the whole repair.
    expect(columnNamesFromTableInfo([null, 42, {}, { name: 7 }, { name: "ok" }])).toEqual(["ok"])
  })

  it("reports nothing for a table that does not exist", () => {
    expect(columnNamesFromTableInfo([])).toEqual([])
  })
})

describe("planRepair", () => {
  const healthy = {
    appointments: ["id", "departments"],
    app_config: ["id", "last_modified"],
    patient_problems: ["id", "last_modified", "server_created_at"],
  }

  it("plans nothing on a device that already has every column", () => {
    expect(planRepair(healthy)).toEqual([])
  })

  it("plans exactly the missing columns on a drifted device", () => {
    expect(
      planRepair({
        appointments: ["id", "reason"],
        app_config: ["id", "last_modified"],
        patient_problems: ["id", "last_modified"],
      }),
    ).toEqual([
      {
        table: "appointments",
        column: "departments",
        sql: 'alter table "appointments" add "departments"',
      },
      {
        table: "patient_problems",
        column: "server_created_at",
        sql: 'alter table "patient_problems" add "server_created_at"',
      },
    ])
  })

  it("skips a table that does not exist on this device", () => {
    // `alter table` on a missing table aborts the batch and strands every
    // statement after it. `repairSchemaDrift` bails before reaching here when a
    // table is absent; this is the inner guard that keeps the planner safe to
    // call on its own.
    expect(planRepair({ ...healthy, appointments: [] })).toEqual([])
    expect(planRepair({ app_config: healthy.app_config })).toEqual([])
  })

  it("is idempotent — replanning after a repair yields nothing", () => {
    const drifted: Record<string, string[]> = {
      appointments: ["id"],
      app_config: ["id"],
      patient_problems: ["id"],
    }
    const plan = planRepair(drifted)
    expect(plan.length).toBe(4)

    for (const step of plan) drifted[step.table].push(step.column)
    expect(planRepair(drifted)).toEqual([])
  })

  it("covers every table named in DRIFTED_COLUMNS", () => {
    const empty = Object.fromEntries(Object.keys(DRIFTED_COLUMNS).map((t) => [t, ["id"]]))
    const tables = new Set(planRepair(empty).map((step) => step.table))

    expect([...tables].sort()).toEqual(Object.keys(DRIFTED_COLUMNS).sort())
  })
})
