/**
 * The web form leaves expiry optional, so a prescription saved without one had
 * no validity window at all. It now falls back to the same 90 days the mobile
 * app writes, measured from the prescribing moment rather than from "now".
 */

import { describe, expect, it } from "vitest";
import { addDays, differenceInCalendarDays } from "date-fns";
import Prescription from "@/models/prescription";

const PRESCRIBED_AT = new Date("2026-03-14T09:15:00.000Z");

describe("Prescription.resolveExpirationDate", () => {
  it("keeps an expiry the clinician set", () => {
    const chosen = new Date("2026-05-01T00:00:00.000Z");

    expect(
      Prescription.resolveExpirationDate(chosen, PRESCRIBED_AT),
    ).toBe(chosen.toISOString());
  });

  it("falls back to ninety days after the prescribing moment", () => {
    expect(Prescription.resolveExpirationDate(null, PRESCRIBED_AT)).toBe(
      addDays(PRESCRIBED_AT, 90).toISOString(),
    );
  });

  it("treats undefined and an empty string the same as null", () => {
    const fromNull = Prescription.resolveExpirationDate(null, PRESCRIBED_AT);

    expect(Prescription.resolveExpirationDate(undefined, PRESCRIBED_AT)).toBe(
      fromNull,
    );
    expect(Prescription.resolveExpirationDate("", PRESCRIBED_AT)).toBe(fromNull);
  });

  it("measures from the prescribing moment, not from now", () => {
    const backdated = new Date("2020-01-01T00:00:00.000Z");
    const expiry = Prescription.resolveExpirationDate(null, backdated);

    expect(differenceInCalendarDays(new Date(expiry), backdated)).toBe(90);
  });

  it("never returns an expiry at or before the prescribing moment", () => {
    const expiry = Prescription.resolveExpirationDate(null, PRESCRIBED_AT);

    expect(new Date(expiry).getTime()).toBeGreaterThan(PRESCRIBED_AT.getTime());
  });

  it("accepts the ISO strings the form actually submits", () => {
    expect(
      Prescription.resolveExpirationDate(null, PRESCRIBED_AT.toISOString()),
    ).toBe(addDays(PRESCRIBED_AT, 90).toISOString());
  });
});
