import { describe, it, expect } from "vitest";
import { Kysely, PostgresDialect } from "kysely";
import {
  syncSelection,
  resolveEntitiesForPeer,
  MOBILE_SYNC_COLUMNS,
  MASKED_VALUE,
  FULL_SNAPSHOT_TABLES,
} from "@/models/sync-shared";
import User from "@/models/user";

/**
 * Devices receive `users` so `recorded_by_user_id` can be shown as a name.
 * Everything past that is withheld in SQL, the only enforcement point.
 *
 * Asserted against compiled SQL, not the builder's internals: the SQL is the
 * actual claim that a withheld column never leaves Postgres.
 */
describe("users sync projection", () => {
  // Compilation never touches the pool, so this needs no database.
  const compiled = (peerType: "android" | "sync_hub"): string => {
    const kysely = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool: {} as never }),
    });
    const selection = syncSelection(User.Table.name, peerType);
    const query = kysely.selectFrom(User.Table.name as never);
    return (
      selection ? query.select(selection as never) : query.selectAll()
    ).compile().sql;
  };

  /** Whether the SQL names this exact column, not one it is a substring of. */
  const names = (sql: string, column: string): boolean =>
    sql.includes(`"${column}"`);

  it("reaches devices at all", () => {
    const mobile = resolveEntitiesForPeer("android", "push").map(
      (e) => e.Table.name,
    );
    expect(mobile).toContain(User.Table.name);
  });

  it("is delivered whole rather than as a delta", () => {
    expect(FULL_SNAPSHOT_TABLES.has(User.Table.name)).toBe(true);
  });

  it("is never accepted back from a device", () => {
    const accepted = resolveEntitiesForPeer("android", "pull").map(
      (e) => e.Table.name,
    );
    expect(accepted).not.toContain(User.Table.name);
    expect(User.Table.ALWAYS_PUSH_TO_MOBILE).toBe(true);
  });

  it("carries what links a provider to the care they gave", () => {
    const sql = compiled("android");
    for (const column of ["id", "name", "role", "clinic_id"]) {
      expect(names(sql, column)).toBe(true);
    }
  });

  // The point of the allowlist: a new Postgres column stays off devices.
  it("withholds every column not listed, credentials included", () => {
    const sql = compiled("android");
    const projection = MOBILE_SYNC_COLUMNS.users;

    for (const column of Object.keys(User.Table.columns)) {
      const allowed =
        projection.columns.includes(column) ||
        projection.masked.includes(column);
      expect(names(sql, column)).toBe(allowed);
    }

    expect(names(sql, "hashed_password")).toBe(false);
    expect(names(sql, "instance_url")).toBe(false);
    expect(sql).not.toMatch(/select \*/);
  });

  it("sends email as a visible mask, not as a blank", () => {
    expect(MASKED_VALUE).toBe("********");
    expect(compiled("android")).toContain(`'${MASKED_VALUE}' as "email"`);
  });

  // Hubs hold full records for the clinics they serve.
  it("leaves hub peers unprojected", () => {
    expect(syncSelection(User.Table.name, "sync_hub")).toBeNull();
    const sql = compiled("sync_hub");
    expect(sql).toMatch(/select \*/);
    expect(sql).not.toContain(MASKED_VALUE);
  });

  it("treats an unrecognised peer as mobile", () => {
    expect(
      syncSelection(User.Table.name, "unknown" as "android"),
    ).not.toBeNull();
  });

  it("leaves every other table selecting everything", () => {
    for (const entity of resolveEntitiesForPeer("android", "push")) {
      if (entity.Table.name === User.Table.name) continue;
      expect(syncSelection(entity.Table.name, "android")).toBeNull();
    }
  });
});
