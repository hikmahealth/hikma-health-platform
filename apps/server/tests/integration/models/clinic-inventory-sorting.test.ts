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

// The list is paged, so its ORDER BY must be a total order. Two drugs share a
// quantity precisely to put that under load.

const ids = {
  clinic: uuidV1(),
  alpha: uuidV1(),
  noBrand: uuidV1(),
  charlie: uuidV1(),
  lowerBeta: uuidV1(),
};

const drugIds = [ids.alpha, ids.noBrand, ids.charlie, ids.lowerBeta];

const batchIds = new Map(drugIds.map((drugId) => [drugId, uuidV1()]));
const batchFor = (drugId: string) => batchIds.get(drugId) as string;

const drugRow = (
  id: string,
  genericName: string,
  brandName: string | null,
) => ({
  id,
  generic_name: genericName,
  brand_name: brandName,
  form: "tablet",
  route: "oral",
  dosage_quantity: 1,
  dosage_units: "mg",
  is_deleted: false,
});

const batchRow = (drugId: string, remaining: number) => ({
  id: batchFor(drugId),
  drug_id: drugId,
  batch_number: `B-${drugId.slice(0, 8)}`,
  expiry_date: sql`'2030-01-01'::date`,
  quantity_received: 500,
  quantity_remaining: remaining,
  received_date: sql`'2026-01-01'::date`,
  is_deleted: false,
  metadata: sql`'{}'::jsonb`,
});

const invRow = (drugId: string, quantityAvailable: number) => ({
  id: uuidV1(),
  clinic_id: ids.clinic,
  drug_id: drugId,
  batch_id: batchFor(drugId),
  batch_number: `B-${drugId.slice(0, 8)}`,
  quantity_available: quantityAvailable,
  reserved_quantity: 0,
  batch_expiry_date: sql<Date>`'2030-01-01'::date`,
  is_deleted: false,
  metadata: sql`'{}'::jsonb`,
});

const seed = async () => {
  await testDb
    .insertInto("clinics")
    .values({ id: ids.clinic, is_deleted: false })
    .execute();

  await testDb
    .insertInto("drug_catalogue")
    .values([
      // Brand sorts before its own generic, so the two orders cannot agree.
      drugRow(ids.alpha, "zinc sulfate", "Alpha Brand"),
      // No brand: the list shows the generic, so brand sort must order on that.
      drugRow(ids.noBrand, "amoxicillin", null),
      drugRow(ids.charlie, "betamethasone", "Charlie Brand"),
      // Lowercase, to catch an ordering that puts capitals first.
      drugRow(ids.lowerBeta, "cetirizine", "beta brand"),
    ])
    .execute();

  await testDb
    .insertInto("drug_batches")
    .values([
      batchRow(ids.alpha, 0),
      batchRow(ids.noBrand, 0),
      batchRow(ids.charlie, 50),
      batchRow(ids.lowerBeta, 25),
    ])
    .execute();

  await testDb
    .insertInto("clinic_inventory")
    .values([
      // Alpha and noBrand tie on zero — the case the tiebreak exists for.
      invRow(ids.alpha, 0),
      invRow(ids.noBrand, 0),
      invRow(ids.charlie, 50),
      invRow(ids.lowerBeta, 25),
    ])
    .execute();
};

const CLEANUP: Array<[string, string, string]> = [
  ...drugIds.map(
    (id) => ["clinic_inventory", "drug_id", id] as [string, string, string],
  ),
  ...drugIds.map(
    (id) => ["drug_batches", "drug_id", id] as [string, string, string],
  ),
  ...drugIds.map(
    (id) => ["drug_catalogue", "id", id] as [string, string, string],
  ),
  ["clinics", "id", ids.clinic],
];

beforeEach(async () => {
  permittedClinicIds = [ids.clinic];
  await seed();
});

afterEach(async () => {
  for (const [table, column, value] of CLEANUP) {
    // @ts-ignore — dynamic table/column name
    await testDb.deleteFrom(table).where(column, "=", value).execute();
  }
});

const listing = async (sort: ClinicInventory.SortOption, limit = 100) =>
  await ClinicInventory.API.getWithDrugInfo(ids.clinic, "", {
    limit,
    offset: 0,
    includeZeroStock: true,
    sort,
  });

describe("getWithDrugInfo sorting", () => {
  it("orders by brand name, falling back to the generic name", async () => {
    const rows = await listing("brand_name");

    // Alpha Brand, amoxicillin (no brand), beta brand, Charlie Brand.
    expect(rows.map((row) => row.drug_id)).toEqual([
      ids.alpha,
      ids.noBrand,
      ids.lowerBeta,
      ids.charlie,
    ]);
  });

  it("folds case, so a lowercase brand is not exiled to the end", async () => {
    const rows = await listing("brand_name");
    const names = rows.map((row) => row.brand_name ?? row.generic_name);

    expect(names.indexOf("beta brand")).toBeLessThan(
      names.indexOf("Charlie Brand"),
    );
  });

  it("orders by generic name, ignoring the brand entirely", async () => {
    const rows = await listing("generic_name");

    expect(rows.map((row) => row.drug_id)).toEqual([
      ids.noBrand,
      ids.charlie,
      ids.lowerBeta,
      ids.alpha,
    ]);
  });

  it("orders by quantity in both directions", async () => {
    const descending = await listing("quantity_desc");
    expect(descending.map((row) => row.quantity)).toEqual([50, 25, 0, 0]);

    const ascending = await listing("quantity_asc");
    expect(ascending.map((row) => row.quantity)).toEqual([0, 0, 25, 50]);
  });

  it("breaks a quantity tie on a stable key, not on whatever pg returns", async () => {
    const first = await listing("quantity_desc");
    const second = await listing("quantity_desc");

    // The tiebreak fixes which zero-quantity drug comes first.
    expect(first.map((row) => row.drug_id)).toEqual(
      second.map((row) => row.drug_id),
    );

    const tied = first.slice(2).map((row) => row.drug_id);
    expect(tied).toEqual([ids.alpha, ids.noBrand].sort());
  });

  it("defaults to the brand-name order when no sort is given", async () => {
    const explicit = await listing("brand_name");
    const implicit = await ClinicInventory.API.getWithDrugInfo(ids.clinic, "", {
      limit: 100,
      offset: 0,
      includeZeroStock: true,
    });

    expect(implicit.map((row) => row.drug_id)).toEqual(
      explicit.map((row) => row.drug_id),
    );
  });
});

describe("getWithDrugInfo paging is total under every sort", () => {
  it.each([...ClinicInventory.SORT_OPTIONS])(
    "returns each drug exactly once across page boundaries, sorted by %s",
    async (sort) => {
      const pageSize = 2;
      const seen: string[] = [];

      for (let offset = 0; offset < drugIds.length; offset += pageSize) {
        const page = await ClinicInventory.API.getWithDrugInfo(
          ids.clinic,
          "",
          { limit: pageSize, offset, includeZeroStock: true, sort },
        );
        seen.push(...page.map((row) => row.drug_id));
      }

      // A duplicate or omission means rows sharing a key drifted.
      expect(new Set(seen).size).toBe(drugIds.length);
      expect([...seen].sort()).toEqual([...drugIds].sort());
    },
  );

  it("agrees with a single unpaged read, sorted by quantity", async () => {
    const whole = await listing("quantity_desc");

    const paged: string[] = [];
    for (let offset = 0; offset < drugIds.length; offset += 1) {
      const page = await ClinicInventory.API.getWithDrugInfo(ids.clinic, "", {
        limit: 1,
        offset,
        includeZeroStock: true,
        sort: "quantity_desc",
      });
      paged.push(...page.map((row) => row.drug_id));
    }

    expect(paged).toEqual(whole.map((row) => row.drug_id));
  });
});
