// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "@hikmahealth/database/types/schema/hh";

const { holder, headers } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  headers: {} as Record<string, string>,
}));

vi.mock("@/db", () => ({
  default: new Proxy(
    {},
    {
      get: (_, key) => {
        const target = holder.db as Record<PropertyKey, unknown>;
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    },
  ),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: (name: string) => headers[name],
}));

import { createPgliteKysely, migrateToLatest } from "../helpers/pglite-kysely";
import { logAuditEvent } from "@/lib/server-functions/audit";

let db: Kysely<DB>;

beforeAll(async () => {
  db = createPgliteKysely();
  holder.db = db;
  await migrateToLatest(db);
}, 60_000);

afterAll(async () => {
  await db.destroy();
});

const rowFor = (rowId: string) =>
  db
    .selectFrom("event_logs")
    .selectAll()
    .where("row_id", "=", rowId)
    .executeTakeFirst();

describe("logAuditEvent request context", () => {
  it("keeps the row when the forwarded address is not an IP", async () => {
    // The header is client-controlled; it must not be able to drop the row.
    headers["x-forwarded-for"] = "not-an-ip";
    await logAuditEvent({
      actionType: "VIEW",
      tableName: "patients",
      rowId: "patient-forged-header",
      changes: {},
      userId: "admin-1",
    });

    const row = await rowFor("patient-forged-header");
    expect(row).toBeDefined();
    expect(row?.ip_address).toBeNull();
  });

  it("stores a real forwarded address", async () => {
    headers["x-forwarded-for"] = "198.51.100.7, 10.0.0.1";
    await logAuditEvent({
      actionType: "VIEW",
      tableName: "patients",
      rowId: "patient-real-header",
      changes: {},
      userId: "admin-1",
    });

    expect(String((await rowFor("patient-real-header"))?.ip_address)).toContain(
      "198.51.100.7",
    );
  });
});
