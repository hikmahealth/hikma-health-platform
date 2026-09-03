import fc from "fast-check"

import DrugCatalogue from "@/models/DrugCatalogue"

describe("DrugCatalogue.displayName", () => {
  it("pairs the brand with the generic when it has both", () => {
    expect(DrugCatalogue.displayName({ brandName: "Panadol", genericName: "Paracetamol" })).toBe(
      "Panadol (Paracetamol)",
    )
  })

  it("falls back to the brand alone", () => {
    expect(DrugCatalogue.displayName({ brandName: "Panadol", genericName: "" })).toBe("Panadol")
  })

  it("falls back to the generic alone", () => {
    expect(DrugCatalogue.displayName({ brandName: null, genericName: "Paracetamol" })).toBe(
      "Paracetamol",
    )
  })

  it("treats a whitespace-only name as absent", () => {
    expect(DrugCatalogue.displayName({ brandName: "   ", genericName: "Paracetamol" })).toBe(
      "Paracetamol",
    )
    expect(DrugCatalogue.displayName({ brandName: " Panadol ", genericName: "  " })).toBe("Panadol")
  })

  it("is empty when it has neither", () => {
    expect(DrugCatalogue.displayName({ brandName: null, genericName: "" })).toBe("")
  })

  describe("against arbitrary catalogue names", () => {
    const anyName = fc.oneof(
      fc.string(),
      fc.constantFrom("", "   ", "\t\n", "بنادول", "🩹", "Drug (500mg)", "0"),
    )

    // Asserted as "the surviving name, alone": a name may legitimately contain
    // "()", so a regex would be testing the catalogue instead of this function.
    it("adds no parenthetical when only one name survives", () => {
      fc.assert(
        fc.property(fc.option(anyName, { nil: null }), anyName, (brandName, genericName) => {
          const brand = brandName?.trim() ?? ""
          const generic = genericName.trim()
          fc.pre((brand === "") !== (generic === ""))

          expect(DrugCatalogue.displayName({ brandName, genericName })).toBe(brand || generic)
        }),
      )
    })

    it("never leaks surrounding whitespace into the label", () => {
      fc.assert(
        fc.property(fc.option(anyName, { nil: null }), anyName, (brandName, genericName) => {
          const label = DrugCatalogue.displayName({ brandName, genericName })
          expect(label).toBe(label.trim())
        }),
      )
    })

    it("is empty exactly when both names are blank", () => {
      fc.assert(
        fc.property(fc.option(anyName, { nil: null }), anyName, (brandName, genericName) => {
          const hasAnyName = Boolean(brandName?.trim()) || Boolean(genericName.trim())
          expect(DrugCatalogue.displayName({ brandName, genericName }) !== "").toBe(hasAnyName)
        }),
      )
    })

    it("keeps both names when it has both", () => {
      fc.assert(
        fc.property(fc.option(anyName, { nil: null }), anyName, (brandName, genericName) => {
          const brand = brandName?.trim() ?? ""
          const generic = genericName.trim()
          fc.pre(brand !== "" && generic !== "")

          const label = DrugCatalogue.displayName({ brandName, genericName })
          expect(label).toContain(brand)
          expect(label).toContain(generic)
        }),
      )
    })
  })
})
