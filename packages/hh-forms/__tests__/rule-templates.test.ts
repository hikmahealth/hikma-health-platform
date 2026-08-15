import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  comparisonOps,
  comparisonOpLabels,
  compileVisibilityTemplate,
  decompileVisibilityTemplate,
  ruleReferencesField,
  remapFormFieldRefs,
  type simpleVisibilityTemplate,
  type visibilityCondition,
  type comparisonOp,
} from "../src/RuleTemplates.gen";
import {
  compileRules,
  type fieldWithRules,
  type ruleScope,
} from "../src/Rules.gen";

/**
 * Compile/decompile parity for the simple-visibility template model and
 * the ruleReferencesField walker. The ReScript-emitted variant shape:
 *
 *   - `Always` is a bare string.
 *   - otherwise `{ TAG: "Conditions", connector, conditions }`, where each
 *     condition is `{ TAG: "Comparison" | "Truthy" | "Falsy", ... }`.
 *
 * A single condition compiles to the bare leaf rule (backward compatible);
 * two or more compile to `{ and: [...] }` / `{ or: [...] }`. Decompile is
 * conservative: any non-leaf member, an `and`/`or` with <2 elements, or a
 * nested group falls back to `undefined` (advanced mode).
 */

const cmp = (
  fieldId: string,
  op: comparisonOp,
  value: unknown,
): visibilityCondition => ({ TAG: "Comparison", fieldId, op, value });
const truthy = (fieldId: string): visibilityCondition => ({ TAG: "Truthy", fieldId });
const falsy = (fieldId: string): visibilityCondition => ({ TAG: "Falsy", fieldId });
const inc = (fieldId: string, value: string): visibilityCondition => ({
  TAG: "IncludesOption",
  fieldId,
  value,
});
const exc = (fieldId: string, value: string): visibilityCondition => ({
  TAG: "ExcludesOption",
  fieldId,
  value,
});
const incAny = (fieldId: string, values: string[]): visibilityCondition => ({
  TAG: "IncludesAny",
  fieldId,
  values,
});
const incAll = (fieldId: string, values: string[]): visibilityCondition => ({
  TAG: "IncludesAll",
  fieldId,
  values,
});
const eqAny = (fieldId: string, values: string[]): visibilityCondition => ({
  TAG: "EqualsAny",
  fieldId,
  values,
});
const lengthCmp = (
  fieldId: string,
  op: comparisonOp,
  value: number,
): visibilityCondition => ({ TAG: "LengthCompare", fieldId, op, value });

// Canonical single-condition template (connector is irrelevant with one
// condition; decompile always reports `and`).
const one = (c: visibilityCondition): simpleVisibilityTemplate => ({
  TAG: "Conditions",
  connector: "and",
  conditions: [c],
});

describe("comparisonOps and labels", () => {
  it("exposes all six operators in the legacy order", () => {
    expect(comparisonOps).toEqual(["==", "!=", ">", ">=", "<", "<="]);
  });

  it("labels every operator with a human-readable string", () => {
    for (const op of comparisonOps) {
      expect(typeof comparisonOpLabels[op]).toBe("string");
      expect(comparisonOpLabels[op]!.length).toBeGreaterThan(0);
    }
  });
});

describe("compileVisibilityTemplate", () => {
  it("compiles Always to undefined (no rule)", () => {
    expect(compileVisibilityTemplate("Always")).toBeUndefined();
  });

  it("compiles an empty condition list to undefined (defensive)", () => {
    expect(
      compileVisibilityTemplate({ TAG: "Conditions", connector: "and", conditions: [] }),
    ).toBeUndefined();
  });

  it("compiles a single == comparison to the bare comparison rule", () => {
    expect(compileVisibilityTemplate(one(cmp("f1", "==", "yes")))).toEqual({
      "==": [{ var: "form.f1" }, "yes"],
    });
  });

  it("compiles a single >= comparison with a numeric literal", () => {
    expect(compileVisibilityTemplate(one(cmp("age", ">=", 18)))).toEqual({
      ">=": [{ var: "form.age" }, 18],
    });
  });

  it("compiles a LengthCompare to a length-wrapped comparison with a defaulted var", () => {
    expect(compileVisibilityTemplate(one(lengthCmp("notes", ">", 10)))).toEqual({
      ">": [{ length: { var: ["form.notes", ""] } }, 10],
    });
  });

  it("compiles a LengthCompare max-length rule", () => {
    expect(compileVisibilityTemplate(one(lengthCmp("code", "<=", 6)))).toEqual({
      "<=": [{ length: { var: ["form.code", ""] } }, 6],
    });
  });

  it("compiles a single Truthy to a bare !! unary form", () => {
    expect(compileVisibilityTemplate(one(truthy("x")))).toEqual({
      "!!": { var: "form.x" },
    });
  });

  it("compiles a single Falsy to a bare ! unary form", () => {
    expect(compileVisibilityTemplate(one(falsy("x")))).toEqual({
      "!": { var: "form.x" },
    });
  });

  it("compiles two AND-ed conditions to an `and` compound", () => {
    expect(
      compileVisibilityTemplate({
        TAG: "Conditions",
        connector: "and",
        conditions: [cmp("age", ">=", 18), cmp("consent", "==", true)],
      }),
    ).toEqual({
      and: [
        { ">=": [{ var: "form.age" }, 18] },
        { "==": [{ var: "form.consent" }, true] },
      ],
    });
  });

  it("compiles OR-ed conditions to an `or` compound", () => {
    expect(
      compileVisibilityTemplate({
        TAG: "Conditions",
        connector: "or",
        conditions: [truthy("a"), truthy("b")],
      }),
    ).toEqual({
      or: [{ "!!": { var: "form.a" } }, { "!!": { var: "form.b" } }],
    });
  });
});

describe("decompileVisibilityTemplate — round-trip across every template", () => {
  const cases: simpleVisibilityTemplate[] = [
    "Always",
    one(cmp("f1", "==", "yes")),
    one(cmp("age", ">=", 18)),
    one(cmp("alive", "!=", true)),
    one(cmp("score", "<", 0)),
    one(cmp("x", ">", null)),
    one(truthy("consent")),
    one(falsy("is_empty")),
    {
      TAG: "Conditions",
      connector: "and",
      conditions: [cmp("age", ">=", 18), cmp("consent", "==", true)],
    },
    {
      TAG: "Conditions",
      connector: "or",
      conditions: [truthy("a"), falsy("b"), cmp("c", "==", 1)],
    },
    one(inc("langs", "en")),
    one(exc("langs", "fr")),
    one(incAny("langs", ["en", "sw"])),
    one(incAll("langs", ["en", "ar"])),
    one(eqAny("city", ["dar", "arusha"])),
    one(lengthCmp("notes", ">", 10)),
    one(lengthCmp("code", "<=", 6)),
    one(lengthCmp("pin", "==", 4)),
    one(lengthCmp("bio", ">=", 0)),
    // Two length bounds on the same field — a distinct concept from membership,
    // so it stays a two-condition group rather than collapsing.
    {
      TAG: "Conditions",
      connector: "and",
      conditions: [lengthCmp("pw", ">=", 8), lengthCmp("pw", "<=", 64)],
    },
    // Includes mixed with a comparison — distinct concerns, so it stays a group.
    {
      TAG: "Conditions",
      connector: "and",
      conditions: [inc("langs", "en"), cmp("age", ">=", 18)],
    },
    // Includes over two *different* fields — not collapsible, stays a group.
    {
      TAG: "Conditions",
      connector: "and",
      conditions: [inc("langs", "en"), inc("diet", "vegan")],
    },
  ];

  for (const tpl of cases) {
    const label = typeof tpl === "string" ? tpl : JSON.stringify(tpl);
    it(`round-trips ${label}`, () => {
      const rule = compileVisibilityTemplate(tpl);
      const back = decompileVisibilityTemplate(rule);
      expect(back).toEqual(tpl);
    });
  }

  it("decompiles undefined to Always", () => {
    expect(decompileVisibilityTemplate(undefined)).toBe("Always");
  });

  it("decompiles null to Always", () => {
    expect(decompileVisibilityTemplate(null)).toBe("Always");
  });

  it("decompiles a single bare condition to a one-element `and` group", () => {
    expect(
      decompileVisibilityTemplate({ "==": [{ var: "form.age" }, 18] }),
    ).toEqual(one(cmp("age", "==", 18)));
  });

  it("decompiles the legacy single-element !! array form", () => {
    expect(decompileVisibilityTemplate({ "!!": [{ var: "form.x" }] })).toEqual(
      one(truthy("x")),
    );
  });

  it("decompiles an `and` compound of leaves to a group", () => {
    expect(
      decompileVisibilityTemplate({
        and: [
          { ">=": [{ var: "form.age" }, 18] },
          { "==": [{ var: "form.consent" }, true] },
        ],
      }),
    ).toEqual({
      TAG: "Conditions",
      connector: "and",
      conditions: [cmp("age", ">=", 18), cmp("consent", "==", true)],
    });
  });

  it("decompiles an `or` compound of leaves to a group", () => {
    expect(
      decompileVisibilityTemplate({
        or: [{ "!!": { var: "form.a" } }, { "!!": { var: "form.b" } }],
      }),
    ).toEqual({
      TAG: "Conditions",
      connector: "or",
      conditions: [truthy("a"), truthy("b")],
    });
  });

  it("covers every comparisonOps entry", () => {
    for (const op of comparisonOps) {
      const t = one(cmp("f", op, 1));
      expect(decompileVisibilityTemplate(compileVisibilityTemplate(t))).toEqual(t);
    }
  });
});

describe("multi-value membership leaves", () => {
  it("compiles IncludesOption to an option-first `in`", () => {
    expect(compileVisibilityTemplate(one(inc("langs", "en")))).toEqual({
      in: ["en", { var: "form.langs" }],
    });
  });

  it("compiles ExcludesOption to a negated `in`", () => {
    expect(compileVisibilityTemplate(one(exc("langs", "en")))).toEqual({
      "!": { in: ["en", { var: "form.langs" }] },
    });
  });

  it("compiles IncludesAny to an `or` of `in`s", () => {
    expect(compileVisibilityTemplate(one(incAny("langs", ["en", "sw"])))).toEqual({
      or: [
        { in: ["en", { var: "form.langs" }] },
        { in: ["sw", { var: "form.langs" }] },
      ],
    });
  });

  it("compiles IncludesAll to an `and` of `in`s", () => {
    expect(compileVisibilityTemplate(one(incAll("langs", ["en", "sw"])))).toEqual({
      and: [
        { in: ["en", { var: "form.langs" }] },
        { in: ["sw", { var: "form.langs" }] },
      ],
    });
  });

  // EqualsAny is the single-valued counterpart of IncludesAny. It must never
  // compile to `in`: the evaluator falls back to substring matching on a string
  // haystack, so `{in: ["opt1", <string>]}` also matches a stored "opt10".
  it("compiles EqualsAny to an `or` of `==`s, not `in`s", () => {
    expect(compileVisibilityTemplate(one(eqAny("city", ["dar", "arusha"])))).toEqual({
      or: [
        { "==": [{ var: "form.city" }, "dar"] },
        { "==": [{ var: "form.city" }, "arusha"] },
      ],
    });
  });

  it("collapses a same-field `or` of `==`s to EqualsAny", () => {
    expect(
      decompileVisibilityTemplate({
        or: [
          { "==": [{ var: "form.city" }, "dar"] },
          { "==": [{ var: "form.city" }, "arusha"] },
        ],
      }),
    ).toEqual(one(eqAny("city", ["dar", "arusha"])));
  });

  it("round-trips EqualsAny", () => {
    const t = one(eqAny("city", ["dar", "arusha", "mwanza"]));
    expect(decompileVisibilityTemplate(compileVisibilityTemplate(t))).toEqual(t);
  });

  it("does not collapse an `or` of `==`s over different fields", () => {
    // Two distinct fields is a genuine two-condition OR, not one "is one of";
    // it stays a group so the multi-row editor keeps both rows.
    expect(
      decompileVisibilityTemplate({
        or: [
          { "==": [{ var: "form.city" }, "dar"] },
          { "==": [{ var: "form.region" }, "dar"] },
        ],
      }),
    ).toEqual({
      TAG: "Conditions",
      connector: "or",
      conditions: [cmp("city", "==", "dar"), cmp("region", "==", "dar")],
    });
  });

  it("does not collapse an `or` mixing `in` and `==` leaves", () => {
    expect(
      decompileVisibilityTemplate({
        or: [
          { in: ["en", { var: "form.langs" }] },
          { "==": [{ var: "form.langs" }, "sw"] },
        ],
      }),
    ).toEqual({
      TAG: "Conditions",
      connector: "or",
      conditions: [inc("langs", "en"), cmp("langs", "==", "sw")],
    });
  });

  it("keeps a non-string `==` group out of EqualsAny", () => {
    // Numeric literals are plain comparisons, not option tokens.
    expect(
      decompileVisibilityTemplate({
        or: [
          { "==": [{ var: "form.age" }, 10] },
          { "==": [{ var: "form.age" }, 20] },
        ],
      }),
    ).toEqual({
      TAG: "Conditions",
      connector: "or",
      conditions: [cmp("age", "==", 10), cmp("age", "==", 20)],
    });
  });

  it("decompiles a bare `in` to IncludesOption", () => {
    expect(
      decompileVisibilityTemplate({ in: ["en", { var: "form.langs" }] }),
    ).toEqual(one(inc("langs", "en")));
  });

  it("leaves the substring `in` form (var-first) in advanced mode", () => {
    // { in: [{var}, "str"] } is string-containment — a different rule.
    expect(
      decompileVisibilityTemplate({ in: [{ var: "form.notes" }, "urgent"] }),
    ).toBeUndefined();
  });

  it("collapses a same-field `or` of `in`s to IncludesAny", () => {
    expect(
      decompileVisibilityTemplate({
        or: [
          { in: ["en", { var: "form.langs" }] },
          { in: ["sw", { var: "form.langs" }] },
        ],
      }),
    ).toEqual(one(incAny("langs", ["en", "sw"])));
  });

  it("collapses a same-field `and` of `in`s to IncludesAll", () => {
    expect(
      decompileVisibilityTemplate({
        and: [
          { in: ["en", { var: "form.langs" }] },
          { in: ["sw", { var: "form.langs" }] },
        ],
      }),
    ).toEqual(one(incAll("langs", ["en", "sw"])));
  });

  it("keeps a different-field `and` of `in`s as a two-condition group", () => {
    expect(
      decompileVisibilityTemplate({
        and: [
          { in: ["en", { var: "form.langs" }] },
          { in: ["vegan", { var: "form.diet" }] },
        ],
      }),
    ).toEqual({
      TAG: "Conditions",
      connector: "and",
      conditions: [inc("langs", "en"), inc("diet", "vegan")],
    });
  });

  it("leaves a single-element `in` group in advanced mode", () => {
    expect(
      decompileVisibilityTemplate({ or: [{ in: ["en", { var: "form.langs" }] }] }),
    ).toBeUndefined();
  });
});

describe("decompileVisibilityTemplate — non-template rules return undefined", () => {
  it("returns undefined for an `and` with a single element", () => {
    expect(
      decompileVisibilityTemplate({ and: [{ ">=": [{ var: "form.age" }, 18] }] }),
    ).toBeUndefined();
  });

  it("returns undefined for an empty `and`", () => {
    expect(decompileVisibilityTemplate({ and: [] })).toBeUndefined();
  });

  it("returns undefined when an `and` member isn't a leaf", () => {
    expect(
      decompileVisibilityTemplate({
        and: [
          { ">=": [{ var: "form.age" }, 18] },
          { if: [{ "==": [{ var: "form.x" }, 1] }, true, false] },
        ],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a nested `and` of `and`", () => {
    expect(
      decompileVisibilityTemplate({
        and: [
          { and: [{ "==": [{ var: "form.a" }, 1] }, { "==": [{ var: "form.b" }, 2] }] },
          { "==": [{ var: "form.c" }, 3] },
        ],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for nested if/else", () => {
    expect(
      decompileVisibilityTemplate({
        if: [{ ">=": [{ var: "form.age" }, 18] }, true, false],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when var doesn't carry the form. prefix", () => {
    expect(
      decompileVisibilityTemplate({ "==": [{ var: "patient.id" }, "x"] }),
    ).toBeUndefined();
  });

  it("returns undefined when RHS isn't a literal", () => {
    expect(
      decompileVisibilityTemplate({
        "==": [{ var: "form.a" }, { var: "form.b" }],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a comparison with wrong arity", () => {
    expect(
      decompileVisibilityTemplate({ "==": [{ var: "form.a" }, 1, 2] }),
    ).toBeUndefined();
  });

  it("returns undefined when the object has multiple keys", () => {
    expect(
      decompileVisibilityTemplate({
        "==": [{ var: "form.a" }, 1],
        "!=": [{ var: "form.b" }, 2],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for an array at the top level", () => {
    expect(decompileVisibilityTemplate([1, 2, 3])).toBeUndefined();
  });

  it("returns undefined for a primitive at the top level", () => {
    expect(decompileVisibilityTemplate(42)).toBeUndefined();
    expect(decompileVisibilityTemplate("hello")).toBeUndefined();
    expect(decompileVisibilityTemplate(true)).toBeUndefined();
  });
});

describe("ruleReferencesField", () => {
  it("returns false for undefined/null/primitive rules", () => {
    expect(ruleReferencesField(undefined, "a")).toBe(false);
    expect(ruleReferencesField(null, "a")).toBe(false);
    expect(ruleReferencesField(42, "a")).toBe(false);
    expect(ruleReferencesField("a", "a")).toBe(false);
    expect(ruleReferencesField(true, "a")).toBe(false);
  });

  it("matches a direct {var: form.<id>} reference", () => {
    expect(ruleReferencesField({ var: "form.age" }, "age")).toBe(true);
  });

  it("doesn't match a different field id", () => {
    expect(ruleReferencesField({ var: "form.consent" }, "age")).toBe(false);
  });

  it("matches subpath access like form.<id>.foo", () => {
    expect(ruleReferencesField({ var: "form.address.street" }, "address")).toBe(true);
  });

  it("doesn't match field-id prefixes (address ≠ address_2)", () => {
    expect(ruleReferencesField({ var: "form.address_2" }, "address")).toBe(false);
  });

  it("walks into nested comparison rules", () => {
    const rule = { ">": [{ var: "form.age" }, 18] };
    expect(ruleReferencesField(rule, "age")).toBe(true);
    expect(ruleReferencesField(rule, "weight")).toBe(false);
  });

  it("walks into and/or trees", () => {
    const rule = {
      and: [
        { "==": [{ var: "form.consent" }, true] },
        { ">": [{ var: "form.age" }, 18] },
      ],
    };
    expect(ruleReferencesField(rule, "age")).toBe(true);
    expect(ruleReferencesField(rule, "consent")).toBe(true);
    expect(ruleReferencesField(rule, "weight")).toBe(false);
  });

  it("handles the array-form {var: [path, default]}", () => {
    expect(ruleReferencesField({ var: ["form.age", 0] }, "age")).toBe(true);
    expect(ruleReferencesField({ var: ["form.other", 0] }, "age")).toBe(false);
  });

  it("returns false for rules with no field references", () => {
    expect(ruleReferencesField({ ">": [3, 2] }, "age")).toBe(false);
    expect(ruleReferencesField({ "==": [true, true] }, "age")).toBe(false);
  });

  it("ignores computed var paths it can't statically resolve", () => {
    const rule = { var: { cat: ["form.", { var: "key" }] } };
    expect(ruleReferencesField(rule, "age")).toBe(false);
  });
});

describe("ruleReferencesField — property: compiled templates always reference their field", () => {
  it("for any single-field condition", () => {
    const fieldIdArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);
    const opArb: fc.Arbitrary<comparisonOp> = fc.constantFrom(...comparisonOps);
    const literalArb = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
    );
    const condArb: fc.Arbitrary<visibilityCondition> = fc.oneof(
      fieldIdArb.map((fieldId) => truthy(fieldId)),
      fieldIdArb.map((fieldId) => falsy(fieldId)),
      fc.tuple(fieldIdArb, opArb, literalArb).map(([fieldId, op, value]) =>
        cmp(fieldId, op, value),
      ),
    );
    fc.assert(
      fc.property(condArb, (c) => {
        const rule = compileVisibilityTemplate(one(c));
        return ruleReferencesField(rule, c.fieldId) === true;
      }),
      { numRuns: 100 },
    );
  });
});

describe("LengthCompare — decompile edge cases", () => {
  it("decompiles the bare-var (hand-authored) length form", () => {
    expect(
      decompileVisibilityTemplate({ ">": [{ length: { var: "form.notes" } }, 10] }),
    ).toEqual(one(lengthCmp("notes", ">", 10)));
  });

  it("keeps a fractional length bound in advanced mode", () => {
    expect(
      decompileVisibilityTemplate({ ">": [{ length: { var: ["form.notes", ""] } }, 2.5] }),
    ).toBeUndefined();
  });

  it("keeps a negative length bound in advanced mode", () => {
    expect(
      decompileVisibilityTemplate({ "<": [{ length: { var: ["form.notes", ""] } }, -1] }),
    ).toBeUndefined();
  });

  it("does not mistake a substring `in` for a length rule", () => {
    // `{in: [{var}, "needle"]}` is substring containment, not a length rule.
    expect(
      decompileVisibilityTemplate({ in: [{ var: "form.notes" }, "needle"] }),
    ).toBeUndefined();
  });
});

describe("LengthCompare — evaluation semantics", () => {
  const scope = (form: Record<string, unknown>): ruleScope => ({
    form,
    ctx: { now: "2026-01-01T00:00:00Z", language: "en" },
  });
  // "must be longer than 10 characters" → valid when length > 10.
  const minLenRule = compileVisibilityTemplate(one(lengthCmp("notes", ">", 10)));
  const field: fieldWithRules = {
    id: "notes",
    validators: [{ id: "min-len", rule: minLenRule!, message: "Too short" }],
  };

  // Compile a length template, attach it as a validator on `notes`, and
  // evaluate it against a single `notes` value. `undefined` models an absent
  // field (no key in scope). Returns pass/fail without per-case boilerplate.
  const evalLen = (tpl: simpleVisibilityTemplate, notesValue: unknown) => {
    const rule = compileVisibilityTemplate(tpl)!;
    const result = compileRules([
      { id: "notes", validators: [{ id: "v", rule, message: "bad" }] },
    ])(notesValue === undefined ? scope({}) : scope({ notes: notesValue }));
    return {
      failed: result.validationErrors.some((e) => e.validatorId === "v"),
      hadDiagnostic: result.diagnostics.length > 0,
    };
  };

  const range: simpleVisibilityTemplate = {
    TAG: "Conditions",
    connector: "and",
    conditions: [lengthCmp("notes", ">=", 6), lengthCmp("notes", "<=", 64)],
  };

  it("flags a too-short value", () => {
    const result = compileRules([field])(scope({ notes: "hi" }));
    expect(result.validationErrors.map((e) => e.validatorId)).toContain("min-len");
    expect(result.diagnostics).toEqual([]);
  });

  it("passes a long-enough value", () => {
    const result = compileRules([field])(
      scope({ notes: "this is comfortably past ten characters" }),
    );
    expect(result.validationErrors).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("flags an absent field as length 0 without an eval error", () => {
    // The whole point of the defaulted var: a missing value coerces to "" so
    // length is 0 — the validator actually fires instead of erroring and
    // passing silently (Rules.computeValidatorErrors treats errors as passes).
    const result = compileRules([field])(scope({}));
    expect(result.validationErrors.map((e) => e.validatorId)).toContain("min-len");
    expect(result.diagnostics).toEqual([]);
  });

  it("evaluates a range validator (>= 6 AND <= 64)", () => {
    expect(evalLen(range, "abcde")).toEqual({ failed: true, hadDiagnostic: false }); // 5 < 6
    expect(evalLen(range, "a".repeat(20))).toEqual({ failed: false, hadDiagnostic: false });
    expect(evalLen(range, "a".repeat(100))).toEqual({ failed: true, hadDiagnostic: false }); // 100 > 64
  });

  it("evaluates an exact-length validator (== 4)", () => {
    const four = one(lengthCmp("notes", "==", 4));
    expect(evalLen(four, "1234").failed).toBe(false);
    expect(evalLen(four, "123").failed).toBe(true);
    expect(evalLen(four, "12345").failed).toBe(true);
  });

  it("counts whitespace — the value is not trimmed", () => {
    // Length reads the raw value (unlike number coercion, which trims): 12
    // spaces satisfies "> 10", 8 spaces does not.
    const gt10 = one(lengthCmp("notes", ">", 10));
    expect(evalLen(gt10, " ".repeat(12)).failed).toBe(false);
    expect(evalLen(gt10, " ".repeat(8)).failed).toBe(true);
  });

  it("measures length in UTF-16 code units (a flag emoji is 4, not 1)", () => {
    // 🇹🇿 is two regional-indicator code points, each a surrogate pair → 4
    // code units. Pins the vendor `length` semantic so "N characters" has a
    // defined, discoverable meaning for non-ASCII input.
    const flag = "🇹🇿";
    expect(evalLen(one(lengthCmp("notes", "==", 4)), flag).failed).toBe(false);
    expect(evalLen(one(lengthCmp("notes", "==", 1)), flag).failed).toBe(true);
  });
})

describe("membership on a single-valued option field — evaluation semantics", () => {
  const scope = (form: Record<string, unknown>): ruleScope => ({
    form,
    ctx: { now: "2026-01-01T00:00:00Z", language: "en" },
  });

  // A single-select stores one string. Evaluate a compiled template as a
  // visibility rule over that string and report whether the field shows.
  const evalVisible = (tpl: simpleVisibilityTemplate, stored: unknown): boolean => {
    const rule = compileVisibilityTemplate(tpl)!;
    const result = compileRules([{ id: "target", visibleIf: rule }])(
      scope({ city: stored, target: null }),
    );
    return result.isVisible("target");
  };

  it("matches the stored option exactly", () => {
    expect(evalVisible(one(cmp("city", "==", "opt1")), "opt1")).toBe(true);
    expect(evalVisible(one(cmp("city", "==", "opt1")), "arusha")).toBe(false);
  });

  it("does not fire on an option that merely contains the token", () => {
    expect(evalVisible(one(cmp("city", "==", "opt1")), "opt10")).toBe(false);
  });

  it("shows the same rule compiled to `in` does substring-match", () => {
    const asMembership = compileVisibilityTemplate(one(inc("city", "opt1")))!;
    const result = compileRules([{ id: "target", visibleIf: asMembership }])(
      scope({ city: "opt10", target: null }),
    );
    expect(result.isVisible("target")).toBe(true);
  });

  it("evaluates EqualsAny as an exact 'is one of'", () => {
    const anyOf = one(eqAny("city", ["dar", "arusha"]));
    expect(evalVisible(anyOf, "dar")).toBe(true);
    expect(evalVisible(anyOf, "arusha")).toBe(true);
    expect(evalVisible(anyOf, "mwanza")).toBe(false);
    expect(evalVisible(anyOf, "dar es salaam")).toBe(false);
  });
})

describe("remapFormFieldRefs", () => {
  const map = { age: "AGE2", consent: "CONSENT2" };

  it("rewrites a direct reference and leaves unmapped ids alone", () => {
    expect(remapFormFieldRefs({ var: "form.age" }, map)).toEqual({
      var: "form.AGE2",
    });
    expect(remapFormFieldRefs({ var: "form.weight" }, map)).toEqual({
      var: "form.weight",
    });
  });

  it("preserves subpaths and non-form scopes", () => {
    expect(remapFormFieldRefs({ var: "form.age.value" }, map)).toEqual({
      var: "form.AGE2.value",
    });
    expect(remapFormFieldRefs({ var: "ctx.now" }, map)).toEqual({
      var: "ctx.now",
    });
  });

  it("doesn't rewrite id prefixes (age ≠ age_2)", () => {
    expect(remapFormFieldRefs({ var: "form.age_2" }, map)).toEqual({
      var: "form.age_2",
    });
  });

  it("rewrites the path of the array form, keeping the default", () => {
    expect(remapFormFieldRefs({ var: ["form.age", ""] }, map)).toEqual({
      var: ["form.AGE2", ""],
    });
  });

  it("rewrites every reference in a nested tree", () => {
    const rule = {
      and: [
        { "==": [{ var: "form.consent" }, true] },
        { ">": [{ length: [{ var: ["form.age", ""] }] }, 2] },
        { in: ["opt1", { var: "form.age" }] },
      ],
    };
    expect(remapFormFieldRefs(rule, map)).toEqual({
      and: [
        { "==": [{ var: "form.CONSENT2" }, true] },
        { ">": [{ length: [{ var: ["form.AGE2", ""] }] }, 2] },
        { in: ["opt1", { var: "form.AGE2" }] },
      ],
    });
  });

  it("does not mutate the input", () => {
    const rule = { "==": [{ var: "form.age" }, 3] };
    remapFormFieldRefs(rule, map);
    expect(rule).toEqual({ "==": [{ var: "form.age" }, 3] });
  });

  it("copies primitives, null and computed var paths through unchanged", () => {
    expect(remapFormFieldRefs(null, map)).toBe(null);
    expect(remapFormFieldRefs(42, map)).toBe(42);
    expect(remapFormFieldRefs({ ">": [3, 2] }, map)).toEqual({ ">": [3, 2] });
    const computed = { var: { cat: ["form.", { var: "key" }] } };
    expect(remapFormFieldRefs(computed, map)).toEqual(computed);
  });

  it("returns undefined rather than a half-rewritten tree when the walk is too large", () => {
    let deep: unknown = { var: "form.age" };
    for (let i = 0; i < 60_000; i += 1) {
      deep = { "!": [deep] };
    }
    expect(remapFormFieldRefs(deep, map)).toBeUndefined();
  });
});
