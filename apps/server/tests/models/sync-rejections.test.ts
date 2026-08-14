import { describe, it, expect } from "vitest";
import { classifyUpsertResult, recordLevelErrorCode } from "@/models/sync";

describe("classifyUpsertResult", () => {
  // What a guard-rejected upsert actually returns, verified against Postgres in
  // tests/integration/models/sync-rejections.test.ts. Note this is NOT
  // `undefined`, contrary to the inline comment in event.ts.
  it("treats a zero row count as a rejection", () => {
    expect(classifyUpsertResult({ numInsertedOrUpdatedRows: 0n } as any)).toBe(
      false,
    );
  });

  it("treats a positive row count as accepted", () => {
    expect(classifyUpsertResult({ numInsertedOrUpdatedRows: 1n } as any)).toBe(
      true,
    );
  });

  // appointment.ts rebuilds the result as `{ numInsertedOrUpdatedRows:
  // Number(...) }`, so the count arrives as a JS number rather than a bigint.
  // Reading only the bigint shape classified a REJECTED appointment as
  // accepted, the client marked it synced, and the next pull overwrote the
  // user's edit.
  it("treats a zero row count as a rejection when it arrives as a number", () => {
    expect(classifyUpsertResult({ numInsertedOrUpdatedRows: 0 } as any)).toBe(
      false,
    );
  });

  it("treats a positive row count as accepted when it arrives as a number", () => {
    expect(classifyUpsertResult({ numInsertedOrUpdatedRows: 1 } as any)).toBe(
      true,
    );
  });

  // `Number(undefined)` is how a count would go wrong silently; it must not
  // read as accepted.
  it("treats a NaN row count as a rejection", () => {
    expect(classifyUpsertResult({ numInsertedOrUpdatedRows: NaN } as any)).toBe(
      false,
    );
  });

  // Defensive: no driver path currently produces these, but a model that adds
  // RETURNING, or a future Kysely change, would.
  it("treats undefined as a rejection", () => {
    expect(classifyUpsertResult(undefined)).toBe(false);
  });

  it("treats null as a rejection", () => {
    expect(classifyUpsertResult(null)).toBe(false);
  });

  it("treats a returned row as accepted", () => {
    expect(classifyUpsertResult({ id: "abc" } as any)).toBe(true);
  });
});

/**
 * A record Postgres refuses is skipped so the rest of the push can land —
 * otherwise one bad row fails the whole request and the client retries it
 * forever. Anything not about the row must keep failing the request, or an
 * outage would report as "everything rejected" with a 200.
 */
describe("recordLevelErrorCode", () => {
  it("attributes a numeric overflow to the record", () => {
    // The production failure: a BMI past numeric(4,2) on patient_vitals.
    expect(recordLevelErrorCode({ code: "22003" })).toBe("22003");
  });

  it("attributes the other data exceptions to the record", () => {
    expect(recordLevelErrorCode({ code: "22001" })).toBe("22001");
    expect(recordLevelErrorCode({ code: "22P02" })).toBe("22P02");
  });

  it("attributes an integrity violation to the record", () => {
    expect(recordLevelErrorCode({ code: "23503" })).toBe("23503");
  });

  it("does not attribute a lost connection to the record", () => {
    expect(recordLevelErrorCode({ code: "08006" })).toBeNull();
    expect(recordLevelErrorCode({ code: "57P01" })).toBeNull();
    expect(recordLevelErrorCode({ code: "53300" })).toBeNull();
  });

  it("reads through a wrapped cause", () => {
    const wrapped = { status: 500, cause: { code: "22003" } };
    expect(recordLevelErrorCode(wrapped)).toBe("22003");
  });

  it("terminates on a cause that points at itself", () => {
    const looping: { code: string; cause?: unknown } = { code: "unknown" };
    looping.cause = looping;
    expect(recordLevelErrorCode(looping)).toBeNull();
  });

  it("treats an error with no code as one for the request to fail on", () => {
    expect(recordLevelErrorCode(new Error("boom"))).toBeNull();
    expect(recordLevelErrorCode(undefined)).toBeNull();
    expect(recordLevelErrorCode(null)).toBeNull();
  });

  it("ignores a non-string code", () => {
    expect(recordLevelErrorCode({ code: 22003 })).toBeNull();
  });
});
