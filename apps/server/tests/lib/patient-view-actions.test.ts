import { describe, expect, it } from "vitest";
import {
  DEFAULT_PATIENT_VIEW_ACTIONS,
  PATIENT_VIEW_ACTIONS,
  canonicalizePatientViewActions,
} from "@/lib/patient-view-actions";

const ids = (entries: { id: string }[]) => entries.map((e) => e.id);
const REGISTRY_IDS = PATIENT_VIEW_ACTIONS.map((a) => a.id);

describe("canonicalizePatientViewActions", () => {
  it("returns the defaults for input that carries no usable entries", () => {
    // The save handler's validator is a passthrough and the loader reads
    // parseValue's `any`, so every one of these can arrive over the wire.
    for (const raw of [
      null,
      undefined,
      "garbage",
      42,
      { id: "vitals" },
      [],
      [null],
      ["vitals"],
      [{ visible: true }],
      [{ id: 7 }],
    ]) {
      expect(canonicalizePatientViewActions(raw)).toEqual(
        DEFAULT_PATIENT_VIEW_ACTIONS,
      );
    }
  });

  it("preserves the input order for a fully specified list", () => {
    const raw = [
      { id: "vitals", visible: true },
      { id: "diagnoses", visible: false },
      { id: "visit_history", visible: true },
      { id: "prescriptions", visible: false },
    ];
    expect(canonicalizePatientViewActions(raw)).toEqual(raw);
  });

  it("appends known actions the input omits, as visible, in registry order", () => {
    const result = canonicalizePatientViewActions([
      { id: "diagnoses", visible: false },
    ]);
    expect(ids(result)).toEqual([
      "diagnoses",
      "visit_history",
      "prescriptions",
      "vitals",
    ]);
    expect(result[0]).toEqual({ id: "diagnoses", visible: false });
    expect(result.slice(1).every((e) => e.visible)).toBe(true);
  });

  it("drops unknown ids", () => {
    const result = canonicalizePatientViewActions([
      { id: "teleconsult", visible: true },
      { id: "vitals", visible: false },
    ]);
    expect(ids(result)).not.toContain("teleconsult");
    expect(ids(result)[0]).toBe("vitals");
  });

  it("skips malformed members without discarding the valid ones", () => {
    const result = canonicalizePatientViewActions([
      null,
      { visible: true },
      "vitals",
      { id: "vitals", visible: false },
    ]);
    expect(ids(result)[0]).toBe("vitals");
    expect(result[0]?.visible).toBe(false);
  });

  it("honours a config that hides every action", () => {
    const raw = REGISTRY_IDS.map((id) => ({ id, visible: false }));
    expect(canonicalizePatientViewActions(raw)).toEqual(raw);
  });

  it("coerces a missing or non-boolean `visible` to a boolean", () => {
    const result = canonicalizePatientViewActions([
      { id: "vitals" },
      { id: "diagnoses", visible: "yes" },
    ]);
    expect(result[0]).toEqual({ id: "vitals", visible: false });
    expect(result[1]).toEqual({ id: "diagnoses", visible: true });
  });

  it("covers every registry action exactly once, whatever the input", () => {
    for (const raw of [null, [], [{ id: "vitals", visible: true }]]) {
      expect(ids(canonicalizePatientViewActions(raw)).sort()).toEqual(
        [...REGISTRY_IDS].sort(),
      );
    }
  });

  it("dedupes repeated ids so React keys stay unique", () => {
    const result = canonicalizePatientViewActions([
      { id: "vitals", visible: true },
      { id: "vitals", visible: false },
    ]);
    expect(ids(result).filter((id) => id === "vitals")).toHaveLength(1);
  });

  it("returns a fresh array so callers can hold it as mutable state", () => {
    const first = canonicalizePatientViewActions(null);
    first.push({ id: "scratch", visible: true });
    expect(canonicalizePatientViewActions(null)).toEqual(
      DEFAULT_PATIENT_VIEW_ACTIONS,
    );
    expect(DEFAULT_PATIENT_VIEW_ACTIONS).toHaveLength(REGISTRY_IDS.length);
  });
});
