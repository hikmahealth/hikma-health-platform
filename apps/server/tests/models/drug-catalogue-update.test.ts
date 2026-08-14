import { describe, it, expect } from "vitest";
import DrugCatalogue from "@/models/drug-catalogue";

const { buildUpdateValues } = DrugCatalogue;

describe("buildUpdateValues", () => {
  it("keeps only the keys the payload carries", () => {
    expect(buildUpdateValues({ generic_name: "Amoxicillin" })).toEqual({
      generic_name: "Amoxicillin",
    });
  });

  it("returns an empty patch for a payload with nothing editable in it", () => {
    expect(buildUpdateValues({})).toEqual({});
  });

  it("drops the columns the server owns", () => {
    // An edit replays the row it loaded, so all of these arrive on every save.
    const patch = buildUpdateValues({
      id: "d1",
      generic_name: "Amoxicillin",
      is_deleted: true,
      deleted_at: new Date("2026-01-02"),
      created_at: new Date("2020-01-01"),
      updated_at: new Date("2020-01-01"),
      last_modified: new Date("2020-01-01"),
      server_created_at: new Date("2020-01-01"),
    });
    expect(patch).toEqual({ generic_name: "Amoxicillin" });
  });

  it("cannot be used to resurrect or delete a row", () => {
    // Soft-delete state moves through softDelete alone.
    expect(buildUpdateValues({ is_deleted: false })).toEqual({});
    expect(buildUpdateValues({ deleted_at: null })).toEqual({});
  });

  it("writes an explicit null, which clears an optional column", () => {
    expect(
      buildUpdateValues({ barcode: null, brand_name: null, notes: null }),
    ).toEqual({ barcode: null, brand_name: null, notes: null });
  });

  it("keeps a falsy value that a defaulting upsert would overwrite", () => {
    // buildUpsertValues turns each of these back into its default.
    expect(
      buildUpdateValues({
        sale_price: 0,
        min_stock_level: 0,
        is_active: false,
        dosage_quantity: 0,
      }),
    ).toEqual({
      sale_price: 0,
      min_stock_level: 0,
      is_active: false,
      dosage_quantity: 0,
    });
  });

  it("serializes metadata, which the column takes as jsonb", () => {
    expect(buildUpdateValues({ metadata: { atc: "J01CA04" } })).toEqual({
      metadata: '{"atc":"J01CA04"}',
    });
  });

  it("leaves metadata alone when the payload omits it", () => {
    expect(buildUpdateValues({ notes: "keep" })).toEqual({ notes: "keep" });
  });
});
