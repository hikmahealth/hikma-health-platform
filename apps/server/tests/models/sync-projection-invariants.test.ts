import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  MOBILE_SYNC_COLUMNS,
  MASKED_VALUE,
  syncSelection,
  resolveEntitiesForPeer,
  FULL_SNAPSHOT_TABLES,
  type SyncEntity,
} from "@/models/sync-shared";

/**
 * Invariants the projection must hold for any table, present or future.
 *
 * sync-user-projection.test.ts walks `User.Table.columns`, so it never visits a
 * name that exists only in `MOBILE_SYNC_COLUMNS` — a typo there passes it and
 * fails only in Postgres. These walk the allowlist instead.
 */

const pushedToMobile: SyncEntity[] = resolveEntitiesForPeer("android", "push");
const pulledFromMobile = new Set(
  resolveEntitiesForPeer("android", "pull").map((e) => e.Table.name),
);
const entityByTable = new Map(pushedToMobile.map((e) => [e.Table.name, e]));

const projectedTables = Object.keys(MOBILE_SYNC_COLUMNS);

describe("mobile sync projection invariants", () => {
  it("projects only tables that are actually pushed to mobile", () => {
    for (const table of projectedTables) {
      expect(entityByTable.has(table)).toBe(true);
    }
  });

  // A 500 on every mobile pull: selectAll() tolerates a column the deployed
  // table lacks, an explicit select list does not.
  it.each(projectedTables)(
    "%s names only columns the entity actually declares",
    (table) => {
      const entity = entityByTable.get(table)!;
      const declared = new Set(Object.keys(entity.Table.columns));
      const projection = MOBILE_SYNC_COLUMNS[table];

      for (const column of [...projection.columns, ...projection.masked]) {
        expect({ column, declared: declared.has(column) }).toEqual({
          column,
          declared: true,
        });
      }
    },
  );

  it.each(projectedTables)("%s never both sends and masks a column", (table) => {
    const projection = MOBILE_SYNC_COLUMNS[table];
    const overlap = projection.columns.filter((c) =>
      projection.masked.includes(c),
    );
    expect(overlap).toEqual([]);
  });

  // `validateRemoteRaw` asserts `'id' in raw` and throws out of the whole
  // `synchronize()` call, taking every other table down with it.
  it.each(projectedTables)("%s carries id", (table) => {
    expect(MOBILE_SYNC_COLUMNS[table].columns).toContain("id");
  });

  // If the table were also accepted back, the next push would write "********"
  // over the real column server-side.
  it.each(projectedTables)("%s is never accepted back from a device", (table) => {
    expect(pulledFromMobile.has(table)).toBe(false);
  });

  // `isSnapshot` resolves off `entity.Table.name`, so a mobile-side name here
  // silently turns the snapshot back into a watermarked delta.
  it("names snapshot tables by their server name", () => {
    for (const table of FULL_SNAPSHOT_TABLES) {
      expect(pushedToMobile.some((e) => e.Table.name === table)).toBe(true);
    }
  });

  it("leaves every unprojected pushed table selecting everything", () => {
    for (const entity of pushedToMobile) {
      if (projectedTables.includes(entity.Table.name)) continue;
      expect(syncSelection(entity.Table.name, "android")).toBeNull();
    }
  });
});

describe("syncSelection against hostile table names", () => {
  // A plain object literal falls through to Object.prototype, so
  // `MOBILE_SYNC_COLUMNS["constructor"]` is truthy and spreading its absent
  // `.columns` throws. Unreachable today; the guard costs one `Object.hasOwn`.
  it.each([
    ["constructor"],
    ["toString"],
    ["hasOwnProperty"],
    ["valueOf"],
    ["__proto__"],
  ])("returns null for the inherited key %s", (table) => {
    expect(syncSelection(table, "android")).toBeNull();
  });

  it("returns null for any table it does not explicitly project", () => {
    fc.assert(
      fc.property(fc.string(), (table) => {
        fc.pre(!projectedTables.includes(table));
        expect(syncSelection(table, "android")).toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it("never projects a hub peer, whatever the table", () => {
    fc.assert(
      fc.property(fc.string(), (table) => {
        expect(syncSelection(table, "sync_hub")).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("treats every non-hub peer type as mobile", () => {
    fc.assert(
      fc.property(fc.string(), (peerType) => {
        fc.pre(peerType !== "sync_hub");
        expect(syncSelection("users", peerType as "android")).not.toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("uses a mask no real column value would collide with", () => {
    expect(MASKED_VALUE).not.toContain("'");
    expect(MASKED_VALUE.trim()).not.toBe("");
  });
});
