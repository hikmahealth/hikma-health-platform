import { describe, it, expect } from "vitest";
import ClinicInventory from "@/models/clinic-inventory";

// A stale or hand-edited sort must still render the page, not fail it.
describe("parseSortOption", () => {
  it("accepts every option the dropdown can offer", () => {
    for (const option of ClinicInventory.SORT_OPTIONS) {
      expect(ClinicInventory.parseSortOption(option)).toBe(option);
    }
  });

  it("falls back to the default for an unknown sort", () => {
    expect(ClinicInventory.parseSortOption("expiry_soonest")).toBe(
      ClinicInventory.DEFAULT_SORT,
    );
    expect(ClinicInventory.parseSortOption("")).toBe(
      ClinicInventory.DEFAULT_SORT,
    );
  });

  it("falls back for values that are not strings at all", () => {
    expect(ClinicInventory.parseSortOption(undefined)).toBe(
      ClinicInventory.DEFAULT_SORT,
    );
    expect(ClinicInventory.parseSortOption(null)).toBe(
      ClinicInventory.DEFAULT_SORT,
    );
    expect(ClinicInventory.parseSortOption({ sort: "brand_name" })).toBe(
      ClinicInventory.DEFAULT_SORT,
    );
  });

  it("does not let a SQL fragment through", () => {
    expect(ClinicInventory.parseSortOption("dc.id ASC; DROP TABLE users")).toBe(
      ClinicInventory.DEFAULT_SORT,
    );
  });

  it("defaults to brand name, which is what the list opens on", () => {
    expect(ClinicInventory.DEFAULT_SORT).toBe("brand_name");
  });
});
