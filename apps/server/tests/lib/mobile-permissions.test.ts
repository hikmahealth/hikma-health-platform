import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  isOverrideEnabled,
  allowsClinic,
  MOBILE_PERMISSIONS_OVERRIDE_KEY,
} from "@/lib/mobile-permissions";
import AppConfig from "@/models/app-config";

describe("mobile permissions override", () => {
  it("keys off the same config row the settings UI writes", () => {
    expect(MOBILE_PERMISSIONS_OVERRIDE_KEY).toBe(
      "disable-mobile-permissions-checking",
    );
  });

  // caller-clinic-permission.test.ts mocks these two, so it cannot notice them
  // drifting. Pin them here against the real module.
  it("reads the flag through the API the mocked tests assume", () => {
    expect(AppConfig.Namespaces.AUTH).toBe("auth");
    expect(typeof AppConfig.API.getScopedValue).toBe("function");
  });

  describe("isOverrideEnabled", () => {
    it.each([
      [true, true],
      ["true", true],
      [false, false],
      ["false", false],
      [null, false],
      [undefined, false],
      ["", false],
      [1, false],
    ])("%o -> %s", (value, expected) => {
      expect(isOverrideEnabled(value)).toBe(expected);
    });
  });

  describe("allowsClinic", () => {
    // The feature: a checked box lets a clinician upload with no grants at all.
    it("allows a clinic the caller has no grant for when overridden", () => {
      expect(allowsClinic(true, [], "clinic-a")).toBe(true);
    });

    it("denies that same clinic when not overridden", () => {
      expect(allowsClinic(false, [], "clinic-a")).toBe(false);
    });

    it("denies a clinic outside the caller's grants", () => {
      expect(allowsClinic(false, ["clinic-b"], "clinic-a")).toBe(false);
    });

    it("allows a granted clinic without the override", () => {
      expect(allowsClinic(false, ["clinic-a", "clinic-b"], "clinic-a")).toBe(
        true,
      );
    });
  });
});

describe("AppConfig.Utils.appliesToClinic", () => {
  // What the settings checkbox stores, and what pre-clinic_ids rows look like.
  it("treats a null scope as every clinic", () => {
    expect(AppConfig.Utils.appliesToClinic(null, "clinic-a")).toBe(true);
    expect(AppConfig.Utils.appliesToClinic(null, null)).toBe(true);
  });

  it("treats an empty scope as no clinic", () => {
    expect(AppConfig.Utils.appliesToClinic([], "clinic-a")).toBe(false);
    expect(AppConfig.Utils.appliesToClinic([], null)).toBe(false);
  });

  it("matches only the listed clinics", () => {
    expect(AppConfig.Utils.appliesToClinic(["clinic-a"], "clinic-a")).toBe(true);
    expect(AppConfig.Utils.appliesToClinic(["clinic-a"], "clinic-b")).toBe(
      false,
    );
  });

  it("does not apply a scoped row to an unknown clinic", () => {
    expect(AppConfig.Utils.appliesToClinic(["clinic-a"], null)).toBe(false);
  });
});

/**
 * These three are the whole authorization decision for the two upload routes.
 * The tests above pin remembered cases; these pin the shape.
 */
describe("override primitives, exhaustively", () => {
  it("enables on nothing but the two documented shapes", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        fc.pre(value !== true && value !== "true");
        expect(isOverrideEnabled(value)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  // Mobile coerces identically. Accepting more or less than it does desyncs
  // what the app offers from what the server allows.
  it.each(["True", "TRUE", " true", "true ", "1", 1, "yes"])(
    "does not enable on the near-miss %o that mobile also rejects",
    (value) => {
      expect(isOverrideEnabled(value)).toBe(false);
    },
  );

  it("without the override, grants exactly the listed clinics", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (granted, clinicId) => {
        expect(allowsClinic(false, granted, clinicId)).toBe(
          granted.includes(clinicId),
        );
      }),
      { numRuns: 500 },
    );
  });

  // An id is matched whole or not at all: no prefix, suffix, or substring.
  it("never grants a clinic that merely resembles a granted one", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (granted, extra) => {
          expect(allowsClinic(false, [granted + extra], granted)).toBe(false);
          expect(allowsClinic(false, [granted], granted + extra)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("with the override, grants regardless of the grant list", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.string(), (granted, clinicId) => {
        expect(allowsClinic(true, granted, clinicId)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // Only SQL NULL covers every clinic. An empty array is "no clinic" — the
  // inverse of what the same column means on event_forms.
  it("only a null scope applies to every clinic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string()),
        fc.option(fc.string(), { nil: null }),
        (scope, clinicId) => {
          const applies = AppConfig.Utils.appliesToClinic(scope, clinicId);
          expect(applies).toBe(clinicId !== null && scope.includes(clinicId));
          expect(AppConfig.Utils.appliesToClinic(null, clinicId)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
