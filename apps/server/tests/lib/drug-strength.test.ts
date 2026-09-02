import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { formatDrugStrength } from "@/lib/utils";

/**
 * `drug_catalogue.dosage_quantity` is `decimal(10, 4)` and reaches the UI as a
 * string from `pg`. A strength that reads differently from what is stocked is
 * a dosing hazard, so the property under test is round-tripping, not shape.
 */
describe("formatDrugStrength", () => {
  it("keeps a sub-milligram strength intact", () => {
    // .toFixed(2) rendered digoxin 0.0625 mg as "0.06".
    expect(formatDrugStrength("0.0625")).toBe("0.0625");
    expect(formatDrugStrength("0.0125")).toBe("0.0125");
  });

  it("trims the column's padding from a whole-number strength", () => {
    expect(formatDrugStrength("500.0000")).toBe("500");
    expect(formatDrugStrength("12.5000")).toBe("12.5");
  });

  it("renders nothing for an absent strength rather than a fabricated zero", () => {
    for (const absent of [null, undefined, "", "   ", "\t"]) {
      expect(formatDrugStrength(absent)).toBe("");
    }
  });

  it("renders nothing for a value that is not a number", () => {
    for (const junk of ["", "abc", "NaN", "Infinity", "1,000"]) {
      expect(formatDrugStrength(junk)).toBe("");
    }
  });

  it("round-trips every strength the column can hold", () => {
    // decimal(10, 4): six integer digits, four fractional.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 0, max: 9_999 }),
        (whole, frac) => {
          const stored = `${whole}.${String(frac).padStart(4, "0")}`;
          const rendered = formatDrugStrength(stored);
          expect(Number(rendered)).toBe(Number(stored));
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("never rounds a strength away, unlike a fixed two places", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999 }), (frac) => {
        const stored = `0.${String(frac).padStart(4, "0")}`;
        // A non-zero strength must never render as zero.
        expect(Number(formatDrugStrength(stored))).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });
});
