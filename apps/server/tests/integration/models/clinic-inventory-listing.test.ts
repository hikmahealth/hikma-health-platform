import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "kysely";
import { v1 as uuidV1 } from "uuid";
import { testDb } from "../setup";

vi.mock("@/db", () => ({ default: testDb }));

let permittedClinicIds: string[] = [];

vi.mock("@/models/user-clinic-permissions", () => ({
  default: {
    API: {
      getClinicIdsWithPermissionFromToken: async () => permittedClinicIds,
    },
  },
}));

import ClinicInventory from "@/models/clinic-inventory";
import { formatDrugStrength } from "@/lib/utils";

/**
 * `getWithDrugInfo` feeds the clinic inventory table directly — the page does
 * arithmetic and strict equality on what it returns. These tests pin the shape
 * the page assumes, which is also the shape `DrugWithBatchInfo` declares.
 */

const ids = {
  clinic: uuidV1(),
  emptyClinic: uuidV1(),
  drug: uuidV1(),
  microDrug: uuidV1(),
  batchOne: uuidV1(),
  batchTwo: uuidV1(),
  batchThree: uuidV1(),
  microBatch: uuidV1(),
};

const batchRow = (id: string, drugId: string, number: string) => ({
  id,
  drug_id: drugId,
  batch_number: number,
  expiry_date: sql`'2030-01-01'::date`,
  quantity_received: 500,
  quantity_remaining: 500,
  received_date: sql`'2026-01-01'::date`,
  is_deleted: false,
  metadata: sql`'{}'::jsonb`,
});

const invRow = (
  clinicId: string,
  drugId: string,
  batchId: string,
  batchNumber: string,
  quantityAvailable: number,
  reservedQuantity: number,
) => ({
  id: uuidV1(),
  clinic_id: clinicId,
  drug_id: drugId,
  batch_id: batchId,
  batch_number: batchNumber,
  quantity_available: quantityAvailable,
  reserved_quantity: reservedQuantity,
  batch_expiry_date: sql<Date>`'2030-01-01'::date`,
  is_deleted: false,
  metadata: sql`'{}'::jsonb`,
});

const seed = async () => {
  await testDb
    .insertInto("clinics")
    .values([
      { id: ids.clinic, is_deleted: false },
      { id: ids.emptyClinic, is_deleted: false },
    ])
    .execute();

  await testDb
    .insertInto("drug_catalogue")
    .values([
      {
        id: ids.drug,
        generic_name: "listing test drug",
        form: "tablet",
        route: "oral",
        dosage_quantity: 500,
        dosage_units: "mg",
        is_deleted: false,
      },
      {
        // decimal(10,4): the column exists to hold sub-milligram strengths.
        id: ids.microDrug,
        generic_name: "listing micro drug",
        form: "tablet",
        route: "oral",
        dosage_quantity: 0.0125,
        dosage_units: "mg",
        is_deleted: false,
      },
    ])
    .execute();

  await testDb
    .insertInto("drug_batches")
    .values([
      batchRow(ids.batchOne, ids.drug, "LIST-1"),
      batchRow(ids.batchTwo, ids.drug, "LIST-2"),
      batchRow(ids.batchThree, ids.drug, "LIST-3"),
      batchRow(ids.microBatch, ids.microDrug, "LIST-MICRO"),
    ])
    .execute();

  await testDb
    .insertInto("clinic_inventory")
    .values([
      // 25 units on the shelf, 10 of them spoken for by a pending prescription.
      invRow(ids.clinic, ids.drug, ids.batchOne, "LIST-1", 25, 10),
      invRow(ids.clinic, ids.drug, ids.batchTwo, "LIST-2", 15, 0),
      // Reconciliation leaves balances below zero in production. Nothing on
      // this shelf to destroy, and it drags the row-level sum away from any
      // figure derived by subtracting the two aggregates.
      invRow(ids.clinic, ids.drug, ids.batchThree, "LIST-3", -10, 0),
      // Stocked but empty — the row the "Out of Stock" badge exists for.
      invRow(ids.clinic, ids.microDrug, ids.microBatch, "LIST-MICRO", 0, 0),
    ])
    .execute();
};

const CLEANUP: Array<[string, string, string]> = [
  ["inventory_transactions", "drug_id", ids.drug],
  ["inventory_transactions", "drug_id", ids.microDrug],
  ["clinic_inventory", "drug_id", ids.drug],
  ["clinic_inventory", "drug_id", ids.microDrug],
  ["drug_batches", "drug_id", ids.drug],
  ["drug_batches", "drug_id", ids.microDrug],
  ["drug_catalogue", "id", ids.drug],
  ["drug_catalogue", "id", ids.microDrug],
  ["clinics", "id", ids.clinic],
  ["clinics", "id", ids.emptyClinic],
];

beforeEach(async () => {
  permittedClinicIds = [ids.clinic, ids.emptyClinic];
  await seed();
});

afterEach(async () => {
  for (const [table, column, value] of CLEANUP) {
    // @ts-ignore — dynamic table/column name
    await testDb.deleteFrom(table).where(column, "=", value).execute();
  }
});

const listing = async (clinicId = ids.clinic) =>
  await ClinicInventory.API.getWithDrugInfo(clinicId, "", {
    limit: 100,
    offset: 0,
    includeZeroStock: true,
  });

const rowFor = async (drugId: string, clinicId = ids.clinic) => {
  const row = (await listing(clinicId)).find((r) => r.drug_id === drugId);
  if (!row) throw new Error(`no listing row for drug ${drugId}`);
  return row;
};

describe("getWithDrugInfo quantity typing", () => {
  it("returns quantity as a number, not a bigint string", async () => {
    // SUM(integer) is bigint, and node-pg hands bigint back as a string unless
    // the query casts. `DrugWithBatchInfo.quantity` promises number, and the
    // page compares it with `item.quantity === 0`.
    const row = await rowFor(ids.drug);
    expect(typeof row.quantity).toBe("number");
    expect(row.quantity).toBe(30);
  });

  it("returns reserved_quantity as a number, not a bigint string", async () => {
    const row = await rowFor(ids.drug);
    expect(typeof row.reserved_quantity).toBe("number");
    expect(row.reserved_quantity).toBe(10);
  });

  it("makes the Out of Stock branch reachable by strict equality", async () => {
    // `item.quantity === 0` is the page's only path to the Out of Stock badge.
    // A string "0" makes that branch dead for every empty shelf.
    const row = await rowFor(ids.microDrug);
    expect(row.quantity === 0).toBe(true);
  });

  it("types every batch quantity the same way as the row total", async () => {
    // JSON_AGG yields real JSON numbers while the sibling SUM does not; a page
    // cannot switch coercion strategy per field.
    const row = await rowFor(ids.drug);
    for (const batch of row.batches) {
      expect(typeof batch.quantity).toBe(typeof row.quantity);
    }
  });
});

describe("getWithDrugInfo agrees with getClinicDrugStock", () => {
  it("reports the same on-hand total as the trusted per-drug summary", async () => {
    const row = await rowFor(ids.drug);
    const stock = await ClinicInventory.API.getClinicDrugStock(
      ids.clinic,
      ids.drug,
    );

    expect(Number(row.quantity)).toBe(stock.quantity_available);
    expect(Number(row.reserved_quantity)).toBe(stock.reserved_quantity);
  });

  it("keeps reserved inside the on-hand total, never alongside it", async () => {
    // reserveQuantity refuses to reserve more than quantity_available, so
    // reserved is a subset. Adding the two double-counts the reserved units.
    const row = await rowFor(ids.drug);
    const stock = await ClinicInventory.API.getClinicDrugStock(
      ids.clinic,
      ids.drug,
    );

    expect(Number(row.reserved_quantity)).toBeLessThanOrEqual(
      Number(row.quantity),
    );
    expect(Number(row.quantity) + Number(row.reserved_quantity)).not.toBe(
      stock.quantity_available,
    );
    expect(Number(row.quantity)).toBe(stock.quantity_available);
  });

  it("still reports a truthful on-hand total after a partial removal", async () => {
    // A removal that hits reserved units leaves quantity_available == reserved,
    // the worst case for anything that sums the two: 10 real units read as 20.
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinic,
      drugId: ids.drug,
      performedBy: null,
    });

    const row = await rowFor(ids.drug);
    const stock = await ClinicInventory.API.getClinicDrugStock(
      ids.clinic,
      ids.drug,
    );

    expect(Number(row.quantity)).toBe(10);
    expect(Number(row.reserved_quantity)).toBe(10);
    expect(stock.quantity_available).toBe(10);
  });
});

describe("getWithDrugInfo destroyable quantity", () => {
  it("reports what a removal would actually destroy, per row", async () => {
    // The server floors each row at zero before summing, so a negative
    // balance cannot subsidise another batch's write-off. Subtracting the
    // reserved aggregate from the quantity aggregate gets this wrong by
    // exactly the negative balance.
    const row = await rowFor(ids.drug);
    const stock = await ClinicInventory.API.getClinicDrugStock(
      ids.clinic,
      ids.drug,
    );

    expect(row.destroyable_quantity).toBe(stock.destroyable_quantity);
    expect(row.destroyable_quantity).toBe(30);
    // What the page would show if it derived free stock from the aggregates.
    expect(row.quantity - row.reserved_quantity).toBe(20);
  });

  it("matches the units a removal goes on to destroy", async () => {
    const before = await rowFor(ids.drug);
    const outcome = await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinic,
      drugId: ids.drug,
      performedBy: null,
    });

    expect(outcome.units_destroyed).toBe(before.destroyable_quantity);
  });

  it("is zero, not negative, for a shelf that is entirely in the red", async () => {
    await testDb
      .updateTable("clinic_inventory")
      .set({ quantity_available: -5, reserved_quantity: 0 })
      .where("clinic_id", "=", ids.clinic)
      .where("drug_id", "=", ids.drug)
      .execute();

    const row = await rowFor(ids.drug);
    expect(row.destroyable_quantity).toBe(0);
  });
});

describe("getWithDrugInfo strength precision", () => {
  it("preserves a sub-milligram strength to the column's four places", async () => {
    // decimal(10,4) — rounding a strength to two places on the way to the
    // screen turns 0.0125 mg into 0.01 mg.
    const row = await rowFor(ids.microDrug);
    expect(Number(row.dosage_quantity)).toBe(0.0125);
    expect(formatDrugStrength(row.dosage_quantity)).toBe("0.0125");
  });
});

describe("getWithDrugInfo listing after removal", () => {
  it("drops a fully removed drug from the clinic's listing", async () => {
    // The page never reloads after a delete; this pins what a reload would show.
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinic,
      drugId: ids.microDrug,
      performedBy: null,
    });

    const rows = await listing();
    expect(rows.map((r) => r.drug_id)).not.toContain(ids.microDrug);
  });

  it("returns an empty listing for a clinic that stocks nothing", async () => {
    expect(await listing(ids.emptyClinic)).toEqual([]);
  });
});
