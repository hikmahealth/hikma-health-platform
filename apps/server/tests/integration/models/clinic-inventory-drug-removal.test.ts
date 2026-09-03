import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

/**
 * Removing a drug from one clinic writes off that clinic's free stock. Three
 * things have to survive it: reservations held for in-flight prescriptions,
 * other clinics' stock, and dispensing history.
 */

const ids = {
  clinicA: uuidV1(),
  clinicB: uuidV1(),
  user: uuidV1(),
  drug: uuidV1(),
  otherDrug: uuidV1(),
  batchOne: uuidV1(),
  batchTwo: uuidV1(),
  batchThree: uuidV1(),
  patient: uuidV1(),
  dispensing: uuidV1(),
};

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
      { id: ids.clinicA, is_deleted: false },
      { id: ids.clinicB, is_deleted: false },
    ])
    .execute();

  await testDb
    .insertInto("users")
    .values({
      id: ids.user,
      name: "Inventory Admin",
      role: "admin",
      email: `drug-removal-${ids.user}@example.test`,
      hashed_password: "x",
      is_deleted: false,
    })
    .execute();

  await testDb
    .insertInto("drug_catalogue")
    .values([
      {
        id: ids.drug,
        generic_name: "Removal Test Drug",
        form: "tablet",
        route: "oral",
        dosage_quantity: 1,
        dosage_units: "mg",
        is_deleted: false,
      },
      {
        id: ids.otherDrug,
        generic_name: "Bystander Drug",
        form: "tablet",
        route: "oral",
        dosage_quantity: 1,
        dosage_units: "mg",
        is_deleted: false,
      },
    ])
    .execute();

  // Batch one is held at both clinics, the way a shared shipment is.
  await testDb
    .insertInto("drug_batches")
    .values([
      {
        id: ids.batchOne,
        drug_id: ids.drug,
        batch_number: "BATCH-1",
        expiry_date: sql`'2030-01-01'::date`,
        quantity_received: 100,
        quantity_remaining: 100,
        received_date: sql`'2026-01-01'::date`,
        is_deleted: false,
        metadata: sql`'{}'::jsonb`,
      },
      {
        id: ids.batchTwo,
        drug_id: ids.drug,
        batch_number: "BATCH-2",
        expiry_date: sql`'2030-06-01'::date`,
        quantity_received: 40,
        quantity_remaining: 40,
        received_date: sql`'2026-01-01'::date`,
        is_deleted: false,
        metadata: sql`'{}'::jsonb`,
      },
      {
        id: ids.batchThree,
        drug_id: ids.drug,
        batch_number: "BATCH-3",
        expiry_date: sql`'2030-09-01'::date`,
        quantity_received: 20,
        quantity_remaining: 20,
        received_date: sql`'2026-01-01'::date`,
        is_deleted: false,
        metadata: sql`'{}'::jsonb`,
      },
    ])
    .execute();

  await testDb
    .insertInto("clinic_inventory")
    .values([
      invRow(ids.clinicA, ids.drug, ids.batchOne, "BATCH-1", 60, 0),
      invRow(ids.clinicA, ids.drug, ids.batchTwo, "BATCH-2", 25, 10),
      // Reconciliation leaves balances below zero in production: nothing on
      // that shelf to destroy.
      invRow(ids.clinicA, ids.drug, ids.batchThree, "BATCH-3", -10, 0),
      invRow(ids.clinicB, ids.drug, ids.batchOne, "BATCH-1", 40, 0),
    ])
    .execute();

  await testDb
    .insertInto("patients")
    .values({
      id: ids.patient,
      given_name: "Removal",
      surname: "Bystander",
      date_of_birth: sql`'1990-01-15'::date`,
      sex: "female",
      citizenship: "US",
      phone: "555-0199",
      is_deleted: false,
      metadata: sql`'{}'::jsonb`,
    })
    .execute();
};

const CLEANUP: Array<[string, string, string]> = [
  ["dispensing_records", "patient_id", ids.patient],
  ["patients", "id", ids.patient],
  ["inventory_transactions", "drug_id", ids.drug],
  ["inventory_transactions", "drug_id", ids.otherDrug],
  ["clinic_inventory", "drug_id", ids.drug],
  ["clinic_inventory", "drug_id", ids.otherDrug],
  ["drug_batches", "drug_id", ids.drug],
  ["drug_batches", "drug_id", ids.otherDrug],
  ["drug_catalogue", "id", ids.drug],
  ["drug_catalogue", "id", ids.otherDrug],
  ["users", "id", ids.user],
  ["clinics", "id", ids.clinicA],
  ["clinics", "id", ids.clinicB],
];

beforeEach(async () => {
  permittedClinicIds = [ids.clinicA, ids.clinicB];
  await seed();
});

afterEach(async () => {
  for (const [table, column, value] of CLEANUP) {
    // @ts-ignore — dynamic table/column name
    await testDb.deleteFrom(table).where(column, "=", value).execute();
  }
});

const inventoryFor = async (clinicId: string, drugId: string) =>
  await testDb
    .selectFrom("clinic_inventory")
    .selectAll()
    .where("clinic_id", "=", clinicId)
    .where("drug_id", "=", drugId)
    .orderBy("batch_number", "asc")
    .execute();

const batchRemaining = async (batchId: string) => {
  const row = await testDb
    .selectFrom("drug_batches")
    .select("quantity_remaining")
    .where("id", "=", batchId)
    .executeTakeFirstOrThrow();
  return row.quantity_remaining;
};

describe("removeDrugFromClinic (integration)", () => {
  it("destroys the free stock and reports what it did", async () => {
    const outcome = await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    // 60 free in batch one, 15 free of the 25 in batch two, none in the
    // negative batch three.
    expect(outcome).toEqual({
      batches_cleared: 2,
      batches_retained: 1,
      units_destroyed: 75,
      units_retained: 10,
    });
  });

  it("soft-deletes the unreserved row with deleted_at set, so mobile drops it", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    const [batchOneRow] = await inventoryFor(ids.clinicA, ids.drug);
    expect(batchOneRow.batch_id).toBe(ids.batchOne);
    expect(batchOneRow.quantity_available).toBe(0);
    expect(batchOneRow.is_deleted).toBe(true);
    expect(batchOneRow.deleted_at).not.toBeNull();
  });

  it("keeps the reserved units on a live row", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    const rows = await inventoryFor(ids.clinicA, ids.drug);
    const reservedRow = rows.find((row) => row.batch_id === ids.batchTwo)!;
    expect(reservedRow.is_deleted).toBe(false);
    expect(reservedRow.deleted_at).toBeNull();
    expect(reservedRow.quantity_available).toBe(10);
    expect(reservedRow.reserved_quantity).toBe(10);
  });

  it("drops each batch total by what this clinic destroyed, not by its balance", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    expect(await batchRemaining(ids.batchOne)).toBe(40);
    expect(await batchRemaining(ids.batchTwo)).toBe(25);
    expect(await batchRemaining(ids.batchThree)).toBe(20);
  });

  it("leaves the other clinic's stock alone", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    const rows = await inventoryFor(ids.clinicB, ids.drug);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_deleted).toBe(false);
    expect(rows[0].quantity_available).toBe(40);
  });

  it("leaves the drug catalogue entry alone", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    const drug = await testDb
      .selectFrom("drug_catalogue")
      .select(["is_deleted", "is_active"])
      .where("id", "=", ids.drug)
      .executeTakeFirstOrThrow();
    expect(drug.is_deleted).toBe(false);
    expect(drug.is_active).toBe(true);
  });

  it("leaves dispensing history alone", async () => {
    await testDb
      .insertInto("dispensing_records")
      .values({
        id: ids.dispensing,
        clinic_id: ids.clinicA,
        drug_id: ids.drug,
        batch_id: ids.batchOne,
        patient_id: ids.patient,
        quantity_dispensed: 5,
        dispensed_by: ids.user,
        dispensed_at: sql`now()`,
        is_deleted: false,
      })
      .execute();

    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    const record = await testDb
      .selectFrom("dispensing_records")
      .select(["is_deleted", "quantity_dispensed"])
      .where("id", "=", ids.dispensing)
      .executeTakeFirstOrThrow();
    expect(record.is_deleted).toBe(false);
    expect(record.quantity_dispensed).toBe(5);
  });

  it("records one inventory transaction per affected row", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
      reason: "Clinic no longer stocks this drug",
    });

    const transactions = await testDb
      .selectFrom("inventory_transactions")
      .selectAll()
      .where("clinic_id", "=", ids.clinicA)
      .where("drug_id", "=", ids.drug)
      .orderBy("quantity", "asc")
      .execute();

    expect(transactions).toHaveLength(3);
    expect(transactions.map((t) => t.quantity)).toEqual([-60, -15, 0]);
    // Each logged balance is the one its row actually ends on, negative
    // included, so quantity + balance_after reconciles.
    expect(transactions.map((t) => t.balance_after)).toEqual([0, 10, -10]);
    for (const transaction of transactions) {
      expect(transaction.transaction_type).toBe("adjustment");
      expect(transaction.reason).toBe("Clinic no longer stocks this drug");
      expect(transaction.performed_by).toBe(ids.user);
    }
  });

  it("is a no-op when the clinic holds no stock of the drug", async () => {
    const outcome = await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.otherDrug,
      performedBy: ids.user,
    });

    expect(outcome).toEqual({
      batches_cleared: 0,
      batches_retained: 0,
      units_destroyed: 0,
      units_retained: 0,
    });
  });

  it("refuses a clinic the caller has no inventory permission for", async () => {
    permittedClinicIds = [ids.clinicB];

    await expect(
      ClinicInventory.API.removeDrugFromClinic({
        clinicId: ids.clinicA,
        drugId: ids.drug,
        performedBy: ids.user,
      }),
    ).rejects.toThrow(/Unauthorized/);

    const rows = await inventoryFor(ids.clinicA, ids.drug);
    expect(rows.every((row) => row.is_deleted === false)).toBe(true);
  });
});

describe("getClinicDrugStock (integration)", () => {
  it("sums only the asking clinic's rows", async () => {
    expect(
      await ClinicInventory.API.getClinicDrugStock(ids.clinicA, ids.drug),
    ).toEqual({
      batch_count: 3,
      quantity_available: 75,
      reserved_quantity: 10,
      destroyable_quantity: 75,
    });
  });

  it("reports zeroes for a drug the clinic never stocked", async () => {
    expect(
      await ClinicInventory.API.getClinicDrugStock(ids.clinicA, ids.otherDrug),
    ).toEqual({
      batch_count: 0,
      quantity_available: 0,
      reserved_quantity: 0,
      destroyable_quantity: 0,
    });
  });

  it("stops counting rows the removal took off the shelves", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    expect(
      await ClinicInventory.API.getClinicDrugStock(ids.clinicA, ids.drug),
    ).toEqual({
      batch_count: 1,
      quantity_available: 10,
      reserved_quantity: 10,
      destroyable_quantity: 0,
    });
  });
});

describe("countStockedDrugs (integration)", () => {
  it("counts distinct drugs, not inventory rows", async () => {
    // Clinic A holds three batch rows, all of the same drug.
    expect(await ClinicInventory.API.countStockedDrugs(ids.clinicA)).toBe(1);
  });

  it("excludes a drug the clinic has no inventory row for", async () => {
    const stocked = await ClinicInventory.API.getWithDrugInfo(ids.clinicA);
    expect(stocked.map((row) => row.drug_id)).not.toContain(ids.otherDrug);
  });

  it("agrees with the number of rows the list returns", async () => {
    const [count, listed] = await Promise.all([
      ClinicInventory.API.countStockedDrugs(ids.clinicA),
      ClinicInventory.API.getWithDrugInfo(ids.clinicA),
    ]);

    expect(count).toBe(listed.length);
  });

  it("honours the search query the list is filtered by", async () => {
    expect(
      await ClinicInventory.API.countStockedDrugs(ids.clinicA, "Removal"),
    ).toBe(1);
    expect(
      await ClinicInventory.API.countStockedDrugs(ids.clinicA, "Nonexistent"),
    ).toBe(0);
  });

  it("drops the drug once its last row is removed", async () => {
    // Clinic B holds one unreserved row, so removal clears it outright.
    expect(await ClinicInventory.API.countStockedDrugs(ids.clinicB)).toBe(1);

    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicB,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    expect(await ClinicInventory.API.countStockedDrugs(ids.clinicB)).toBe(0);
    // Clinic A keeps its reserved row, so the drug still stocks there.
    expect(await ClinicInventory.API.countStockedDrugs(ids.clinicA)).toBe(1);
  });
});

describe("the confirmation preview and the operation agree (integration)", () => {
  // The modal shows destroyable_quantity before the user confirms. If the two
  // diverge, the dialog promises a number the operation will not honour.
  it("destroys exactly the quantity the preview reported", async () => {
    const preview = await ClinicInventory.API.getClinicDrugStock(
      ids.clinicA,
      ids.drug,
    );

    const outcome = await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    expect(outcome.units_destroyed).toBe(preview.destroyable_quantity);
  });
});

describe("re-stocking a removed drug (integration)", () => {
  // The (clinic, drug, batch) unique index spans soft-deleted rows, so the
  // removed row has to be revived rather than inserted again.
  it("revives the removed row and restarts its balance from zero", async () => {
    await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });

    await ClinicInventory.API.updateQuantity({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      batchId: ids.batchOne,
      batchNumber: "BATCH-1",
      batchExpiryDate: new Date("2030-01-01"),
      quantityChange: 30,
      transactionType: "receiving",
      performedBy: ids.user,
    });

    const rows = await inventoryFor(ids.clinicA, ids.drug);
    const revived = rows.find((row) => row.batch_id === ids.batchOne)!;
    expect(revived.is_deleted).toBe(false);
    expect(revived.deleted_at).toBeNull();
    expect(revived.quantity_available).toBe(30);
  });
});

// Clearing a clinic must land where removing each drug one at a time would.
// The extra ground covered here is the per-drug tally.
describe("clearClinicInventory (integration)", () => {
  const otherBatch = uuidV1();

  // On top of the shared fixture, so the per-drug tests keep their single-drug
  // clinic. CLEANUP already covers both rows via `ids.otherDrug`.
  beforeEach(async () => {
    await testDb
      .insertInto("drug_batches")
      .values({
        id: otherBatch,
        drug_id: ids.otherDrug,
        batch_number: "OTHER-1",
        expiry_date: sql`'2030-01-01'::date`,
        quantity_received: 30,
        quantity_remaining: 30,
        received_date: sql`'2026-01-01'::date`,
        is_deleted: false,
        metadata: sql`'{}'::jsonb`,
      })
      .execute();

    await testDb
      .insertInto("clinic_inventory")
      .values(
        invRow(ids.clinicA, ids.otherDrug, otherBatch, "OTHER-1", 30, 0),
      )
      .execute();
  });

  it("writes off every drug and tallies them separately from batches", async () => {
    const outcome = await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    // The test drug loses 60 + 15 and keeps 10 reserved; the bystander loses
    // its whole 30. Only the first is still stocked, so only it is retained.
    expect(outcome).toEqual({
      batches_cleared: 3,
      batches_retained: 1,
      units_destroyed: 105,
      units_retained: 10,
      drugs_cleared: 1,
      drugs_retained: 1,
    });
  });

  it("matches what removing each drug individually would have done", async () => {
    const first = await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.drug,
      performedBy: ids.user,
    });
    const second = await ClinicInventory.API.removeDrugFromClinic({
      clinicId: ids.clinicA,
      drugId: ids.otherDrug,
      performedBy: ids.user,
    });

    expect({
      batches_cleared: first.batches_cleared + second.batches_cleared,
      batches_retained: first.batches_retained + second.batches_retained,
      units_destroyed: first.units_destroyed + second.units_destroyed,
      units_retained: first.units_retained + second.units_retained,
    }).toEqual({
      batches_cleared: 3,
      batches_retained: 1,
      units_destroyed: 105,
      units_retained: 10,
    });
  });

  it("keeps reserved units on a live row, so the clinic is not left empty", async () => {
    await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    const rows = await inventoryFor(ids.clinicA, ids.drug);
    const reservedRow = rows.find((row) => row.batch_id === ids.batchTwo)!;
    expect(reservedRow.is_deleted).toBe(false);
    expect(reservedRow.deleted_at).toBeNull();
    expect(reservedRow.quantity_available).toBe(10);
    expect(reservedRow.reserved_quantity).toBe(10);

    const cleared = rows.find((row) => row.batch_id === ids.batchOne)!;
    expect(cleared.is_deleted).toBe(true);
    expect(cleared.deleted_at).not.toBeNull();
  });

  it("leaves the other clinic's shelves untouched", async () => {
    await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    const rows = await inventoryFor(ids.clinicB, ids.drug);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_deleted).toBe(false);
    expect(rows[0].quantity_available).toBe(40);
  });

  it("leaves both drugs in the catalogue", async () => {
    await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    const drugs = await testDb
      .selectFrom("drug_catalogue")
      .select(["id", "is_deleted"])
      .where("id", "in", [ids.drug, ids.otherDrug])
      .execute();

    expect(drugs).toHaveLength(2);
    expect(drugs.every((drug) => drug.is_deleted === false)).toBe(true);
  });

  it("drops each batch total by what this clinic destroyed", async () => {
    await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    // Batch one is shared with clinic B, which keeps its 40.
    expect(await batchRemaining(ids.batchOne)).toBe(40);
    expect(await batchRemaining(ids.batchTwo)).toBe(25);
    expect(await batchRemaining(ids.batchThree)).toBe(20);
    expect(await batchRemaining(otherBatch)).toBe(0);
  });

  it("logs one adjustment per batch it touched", async () => {
    await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    const logged = await testDb
      .selectFrom("inventory_transactions")
      .select(["drug_id", "quantity"])
      .where("clinic_id", "=", ids.clinicA)
      .where("drug_id", "in", [ids.drug, ids.otherDrug])
      .execute();

    expect(logged).toHaveLength(4);
    expect(
      logged.reduce((total, row) => total + Number(row.quantity), 0),
    ).toBe(-105);
  });

  it("is a no-op on a clinic that has already been cleared", async () => {
    await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    const second = await ClinicInventory.API.clearClinicInventory({
      clinicId: ids.clinicA,
      performedBy: ids.user,
    });

    // The reserved row survives the first pass with nothing left to destroy.
    expect(second).toEqual({
      batches_cleared: 0,
      batches_retained: 1,
      units_destroyed: 0,
      units_retained: 10,
      drugs_cleared: 0,
      drugs_retained: 1,
    });
  });

  it("refuses a clinic the caller does not administer", async () => {
    permittedClinicIds = [ids.clinicB];

    await expect(
      ClinicInventory.API.clearClinicInventory({
        clinicId: ids.clinicA,
        performedBy: ids.user,
      }),
    ).rejects.toThrow("Unauthorized");

    const rows = await inventoryFor(ids.clinicA, ids.drug);
    expect(rows.every((row) => row.is_deleted === false)).toBe(true);
  });
});
