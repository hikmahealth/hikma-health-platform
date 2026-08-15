import { describe, expect, it } from "vitest";

import {
  conditionKindsFor,
  conditionValid,
  defaultConditionFor,
  defaultConditionForKind,
  displayKindOf,
  type EditorConfig,
  editorReduce,
  editorRuleState,
  initEditorState,
  isScalarOptionField,
  isSimpleRepresentable,
  templateFromConditions,
  unknownOptionTokens,
} from "@/components/form-builder/field-logic/rule-model";
import {
  compileVisibilityTemplate,
  decompileVisibilityTemplate,
  type LogicField,
  type SimpleVisibilityTemplate,
  type VisibilityCondition,
} from "@/lib/form-rule-templates";
import type { JsonLogicRule } from "@/models/form-rules";

/**
 * Coverage strategy: Radix Tabs don't flip state under jsdom, so the
 * simple/advanced tab-switch orchestration can't be driven through the
 * UI. These tests exercise the pure editor state machine directly —
 * init, per-tab edits, and the cross-sync (or skip-sync) on mode
 * switch. Compile/decompile correctness has its own unit-test file;
 * here we assert relationally against those functions.
 */

const fields: LogicField[] = [
  { id: "age", displayName: "Age", kind: "primitive", primitiveKind: "number" },
  {
    id: "consent",
    displayName: "Consent",
    kind: "primitive",
    primitiveKind: "boolean",
  },
];

const sectionConfig: EditorConfig = {
  allowAlways: true,
  allowMultiple: true,
  fields,
};

// A single-valued option field. Membership rules over it are the case that
// needs the option list to be editable in Simple mode.
const optionFields: LogicField[] = [
  ...fields,
  {
    id: "severity",
    displayName: "Severity",
    kind: "primitive",
    primitiveKind: "string",
    options: [
      { value: "mild", label: "Mild" },
      { value: "severe", label: "Severe" },
    ],
  },
];

const optionConfig: EditorConfig = {
  allowAlways: true,
  allowMultiple: true,
  fields: optionFields,
};

const validatorConfig: EditorConfig = {
  allowAlways: false,
  allowMultiple: false,
  fields,
};

const ageRule: JsonLogicRule = { "==": [{ var: "form.age" }, 18] };
const orRule: JsonLogicRule = {
  or: [
    { "==": [{ var: "form.age" }, 18] },
    { "==": [{ var: "form.consent" }, true] },
  ],
};

describe("initEditorState", () => {
  it("opens Simple on 'Always' when no rule is stored and the section allows it", () => {
    const state = initEditorState(sectionConfig, undefined);
    expect(state).toEqual({ mode: "simple", template: "Always", text: "" });
  });

  it("seeds Simple mode from a representable stored rule", () => {
    const state = initEditorState(sectionConfig, ageRule);
    expect(state.mode).toBe("simple");
    expect(state.template).toEqual(decompileVisibilityTemplate(ageRule));
    expect(state.text).toBe(JSON.stringify(ageRule, null, 2));
  });

  // The multi-condition editor carries a connector picker, so an OR group
  // opens in Simple with its connector preserved.
  it("opens Simple for an OR group, preserving the connector", () => {
    const state = initEditorState(sectionConfig, orRule);
    expect(state.mode).toBe("simple");
    expect(state.template).toEqual(decompileVisibilityTemplate(orRule));
    expect(state.template).toMatchObject({ connector: "or" });
  });

  it("still opens Advanced for a rule no template shape covers", () => {
    // An if/else has no simple-template equivalent at any connector.
    const nested: JsonLogicRule = {
      if: [{ ">=": [{ var: "form.age" }, 18] }, true, false],
    };
    const state = initEditorState(sectionConfig, nested);
    expect(state.mode).toBe("advanced");
    expect(state.template).toBe("Always");
  });

  it("opens a fresh validator in Advanced with a default comparison row on the preferred field", () => {
    const state = initEditorState(validatorConfig, undefined, "consent");
    // No stored rule decompiles to "Always", which validators can't
    // represent (they must carry a rule) — hence Advanced.
    expect(state.mode).toBe("advanced");
    expect(state.template).toEqual({
      TAG: "Conditions",
      connector: "and",
      conditions: [
        { TAG: "Comparison", fieldId: "consent", op: "==", value: "" },
      ],
    });
  });
});

describe("editorReduce — per-tab edits", () => {
  it("editTemplate patches only the template", () => {
    const before = initEditorState(sectionConfig, ageRule);
    const after = editorReduce(sectionConfig, before, {
      kind: "editTemplate",
      template: "Always",
    });
    expect(after.template).toBe("Always");
    expect(after.mode).toBe(before.mode);
    expect(after.text).toBe(before.text);
  });

  it("editText patches only the text", () => {
    const before = initEditorState(sectionConfig, ageRule);
    const after = editorReduce(sectionConfig, before, {
      kind: "editText",
      text: "{ nonsense",
    });
    expect(after.text).toBe("{ nonsense");
    expect(after.mode).toBe(before.mode);
    expect(after.template).toBe(before.template);
  });

  it("switching to the current mode returns the state unchanged", () => {
    const before = initEditorState(sectionConfig, undefined);
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });
    expect(after).toBe(before);
  });
});

describe("editorReduce — switch to Advanced", () => {
  it("syncs the JSON text from a fully-authored simple template", () => {
    const template = decompileVisibilityTemplate(ageRule);
    if (template === undefined)
      throw new Error("expected decompile to succeed");
    const before = editorReduce(
      sectionConfig,
      initEditorState(sectionConfig, undefined),
      { kind: "editTemplate", template },
    );
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "advanced",
    });
    expect(after.mode).toBe("advanced");
    expect(after.text).toBe(
      JSON.stringify(compileVisibilityTemplate(template), null, 2),
    );
  });

  it("keeps the existing JSON when the simple draft is incomplete", () => {
    const incomplete = {
      TAG: "Conditions",
      connector: "and",
      conditions: [{ TAG: "Comparison", fieldId: "age", op: "==", value: "" }],
    } as const;
    const seeded = initEditorState(sectionConfig, ageRule);
    const before = editorReduce(sectionConfig, seeded, {
      kind: "editTemplate",
      template: incomplete,
    });
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "advanced",
    });
    expect(after.mode).toBe("advanced");
    expect(after.text).toBe(seeded.text);
  });

  it("clears the JSON when the simple draft is 'Always' (no rule)", () => {
    const seeded = initEditorState(sectionConfig, ageRule);
    const before = editorReduce(sectionConfig, seeded, {
      kind: "editTemplate",
      template: "Always",
    });
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "advanced",
    });
    expect(after.text).toBe("");
  });
});

describe("editorReduce — switch to Simple", () => {
  const inAdvanced = (config: EditorConfig, text: string) => {
    const seeded = editorReduce(config, initEditorState(config, undefined), {
      kind: "switchMode",
      mode: "advanced",
    });
    return editorReduce(config, seeded, { kind: "editText", text });
  };

  it("syncs the template from valid, representable JSON", () => {
    const before = inAdvanced(sectionConfig, JSON.stringify(ageRule));
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });
    expect(after.mode).toBe("simple");
    expect(after.template).toEqual(decompileVisibilityTemplate(ageRule));
  });

  // Regression: the reducer used to call syncTemplateFromAdvanced without the
  // config's fields. Membership leaves need the option list to be editable in
  // Simple, so with no fields every one of them read as unrepresentable and the
  // switch silently kept the stale prior template — discarding what the author
  // had just typed in Advanced.
  it("carries a membership rule over from Advanced, not the stale template", () => {
    const membershipRule: JsonLogicRule = {
      or: [
        { "==": [{ var: "form.severity" }, "mild"] },
        { "==": [{ var: "form.severity" }, "severe"] },
      ],
    };
    const before = inAdvanced(optionConfig, JSON.stringify(membershipRule));
    const after = editorReduce(optionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });

    expect(after.mode).toBe("simple");
    expect(after.template).toEqual(decompileVisibilityTemplate(membershipRule));
    expect(after.template).toMatchObject({
      conditions: [{ TAG: "EqualsAny", fieldId: "severity" }],
    });
  });

  it("syncs to 'Always' from empty JSON when the section allows a no-rule state", () => {
    const before = inAdvanced(sectionConfig, "");
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });
    expect(after.template).toBe("Always");
  });

  it("keeps the existing template when the JSON is malformed", () => {
    const before = inAdvanced(sectionConfig, "{ not json");
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });
    expect(after.mode).toBe("simple");
    expect(after.template).toBe(before.template);
  });

  it("keeps the existing template when the JSON isn't representable", () => {
    // An if/else has no template shape at any connector.
    const before = inAdvanced(
      sectionConfig,
      JSON.stringify({
        if: [{ ">=": [{ var: "form.age" }, 18] }, true, false],
      }),
    );
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });
    expect(after.mode).toBe("simple");
    expect(after.template).toBe(before.template);
  });

  it("syncs an OR group into the simple draft, connector intact", () => {
    const before = inAdvanced(sectionConfig, JSON.stringify(orRule));
    const after = editorReduce(sectionConfig, before, {
      kind: "switchMode",
      mode: "simple",
    });
    expect(after.template).toEqual(decompileVisibilityTemplate(orRule));
    expect(after.template).toMatchObject({ connector: "or" });
  });
});

describe("editorRuleState", () => {
  it("evaluates the simple draft when Simple is active", () => {
    const template = decompileVisibilityTemplate(ageRule);
    if (template === undefined)
      throw new Error("expected decompile to succeed");
    const state = editorReduce(
      sectionConfig,
      initEditorState(sectionConfig, undefined),
      { kind: "editTemplate", template },
    );
    expect(editorRuleState(sectionConfig, state)).toEqual({
      rule: compileVisibilityTemplate(template),
      isValid: true,
    });
  });

  it("treats empty advanced text as valid only when the section allows no rule", () => {
    const emptyAdvanced = {
      mode: "advanced",
      template: "Always",
      text: "",
    } as const;
    expect(editorRuleState(sectionConfig, emptyAdvanced)).toEqual({
      rule: undefined,
      isValid: true,
    });
    expect(editorRuleState(validatorConfig, emptyAdvanced)).toEqual({
      rule: undefined,
      isValid: false,
    });
  });

  it("marks malformed advanced text invalid", () => {
    const state = {
      mode: "advanced",
      template: "Always",
      text: "{ not json",
    } as const;
    expect(editorRuleState(sectionConfig, state).isValid).toBe(false);
  });
});

const langs: LogicField = {
  id: "langs",
  displayName: "Languages",
  kind: "primitive",
  primitiveKind: "string",
  multiValue: true,
  options: [
    { value: "en", label: "English" },
    { value: "sw", label: "Swahili" },
  ],
};

// Free-text field (single-line text): the only surface that offers length
// comparison. A `select` shares primitiveKind "string" but is option-backed,
// so it must NOT offer length.
const notes: LogicField = {
  id: "notes",
  displayName: "Notes",
  kind: "primitive",
  primitiveKind: "string",
  freeText: true,
};

const city: LogicField = {
  id: "city",
  displayName: "City",
  kind: "primitive",
  primitiveKind: "string",
  options: [{ value: "dar", label: "Dar es Salaam" }],
};

describe("conditionKindsFor", () => {
  it("offers comparison + presence for a scalar field", () => {
    expect(conditionKindsFor(fields[0])).toEqual([
      "Comparison",
      "Truthy",
      "Falsy",
    ]);
  });

  it("swaps comparison for membership kinds on a multi-value field", () => {
    expect(conditionKindsFor(langs)).toEqual([
      "IncludesOption",
      "ExcludesOption",
      "IncludesAny",
      "IncludesAll",
      "Truthy",
      "Falsy",
    ]);
  });

  it("adds length comparison for a free-text field", () => {
    expect(conditionKindsFor(notes)).toEqual([
      "Comparison",
      "LengthCompare",
      "Truthy",
      "Falsy",
    ]);
  });

  it("offers membership kinds on a single-valued option field, minus includes-all", () => {
    expect(conditionKindsFor(city)).toEqual([
      "IncludesOption",
      "ExcludesOption",
      "IncludesAny",
      "Truthy",
      "Falsy",
    ]);
  });

  it("keeps the plain comparison set for an option field with no options yet", () => {
    expect(conditionKindsFor({ ...city, options: [] })).toEqual([
      "Comparison",
      "Truthy",
      "Falsy",
    ]);
  });

  it("unions in the current kind when the field no longer offers it", () => {
    // A legacy `>` rule on an option field: without this the dropdown would
    // have no matching item and render blank.
    expect(
      conditionKindsFor(city, {
        TAG: "Comparison",
        fieldId: "city",
        op: ">",
        value: "dar",
      }),
    ).toContain("Comparison");
  });

  it("falls back to the scalar set for a missing field", () => {
    expect(conditionKindsFor(undefined)).toEqual([
      "Comparison",
      "Truthy",
      "Falsy",
    ]);
  });
});

describe("connector representability", () => {
  const two = (connector: "and" | "or"): SimpleVisibilityTemplate => ({
    TAG: "Conditions",
    connector,
    conditions: [
      { TAG: "Comparison", fieldId: "age", op: ">=", value: 18 },
      { TAG: "Comparison", fieldId: "consent", op: "==", value: true },
    ],
  });

  it("represents a multi-condition OR group in Simple mode", () => {
    expect(isSimpleRepresentable(two("or"), true, true)).toBe(true);
  });

  it("still represents a multi-condition AND group", () => {
    expect(isSimpleRepresentable(two("and"), true, true)).toBe(true);
  });

  it("keeps a multi-condition group out of a single-condition section", () => {
    expect(isSimpleRepresentable(two("or"), false, false)).toBe(false);
  });

  it("carries the chosen connector into the compiled rule", () => {
    expect(compileVisibilityTemplate(two("or"))).toEqual({
      or: [
        { ">=": [{ var: "form.age" }, 18] },
        { "==": [{ var: "form.consent" }, true] },
      ],
    });
  });

  // Two membership rows on the SAME field, OR-ed, are exactly "includes any of",
  // so they normalize to one leaf on reload — as AND already does for "includes
  // all of". The compiled rule is identical; only the editor shape changes.
  it("normalizes same-field OR-ed membership rows into one includes-any row", () => {
    const twoRows: SimpleVisibilityTemplate = {
      TAG: "Conditions",
      connector: "or",
      conditions: [
        { TAG: "IncludesOption", fieldId: "langs", value: "en" },
        { TAG: "IncludesOption", fieldId: "langs", value: "sw" },
      ],
    };
    const rule = compileVisibilityTemplate(twoRows);
    expect(rule).toEqual({
      or: [
        { in: ["en", { var: "form.langs" }] },
        { in: ["sw", { var: "form.langs" }] },
      ],
    });
    expect(decompileVisibilityTemplate(rule)).toEqual({
      TAG: "Conditions",
      connector: "and",
      conditions: [
        { TAG: "IncludesAny", fieldId: "langs", values: ["en", "sw"] },
      ],
    });
  });

  it("leaves OR-ed rows over different fields as two rows", () => {
    const rule = compileVisibilityTemplate({
      TAG: "Conditions",
      connector: "or",
      conditions: [
        { TAG: "IncludesOption", fieldId: "langs", value: "en" },
        { TAG: "IncludesOption", fieldId: "diet", value: "vegan" },
      ],
    });
    expect(decompileVisibilityTemplate(rule)).toMatchObject({
      connector: "or",
      conditions: [{ fieldId: "langs" }, { fieldId: "diet" }],
    });
  });

  it("switches connector without disturbing the conditions", () => {
    const t = two("and");
    const conditions = t === "Always" ? [] : t.conditions;
    expect(templateFromConditions(conditions, "or", true)).toEqual(two("or"));
  });
});

describe("unknownOptionTokens", () => {
  const opts = [
    { value: "dar", label: "Dar es Salaam" },
    { value: "arusha", label: "Arusha" },
  ];

  it("reports a token the field no longer offers", () => {
    expect(unknownOptionTokens(["dar", "mwanza"], opts)).toEqual(["mwanza"]);
  });

  it("reports nothing when every token still resolves", () => {
    expect(unknownOptionTokens(["dar", "arusha"], opts)).toEqual([]);
  });

  it("ignores the empty token — that's 'nothing picked yet', not stale", () => {
    expect(unknownOptionTokens([""], opts)).toEqual([]);
  });

  // A field with no options can't distinguish "not loaded" from "all deleted",
  // so it stays silent rather than flagging every token.
  it("stays silent when the field carries no options", () => {
    expect(unknownOptionTokens(["dar"], [])).toEqual([]);
    expect(unknownOptionTokens(["dar"], undefined)).toEqual([]);
  });

  it("matches on option value, not label", () => {
    expect(unknownOptionTokens(["Dar es Salaam"], opts)).toEqual([
      "Dar es Salaam",
    ]);
  });
});

describe("single-valued option fields", () => {
  it("classifies an option-backed scalar field, but not an empty or multi one", () => {
    expect(isScalarOptionField(city)).toBe(true);
    expect(isScalarOptionField({ ...city, options: [] })).toBe(false);
    expect(isScalarOptionField(langs)).toBe(false);
    expect(isScalarOptionField(undefined)).toBe(false);
  });

  // `in` degrades to substring matching against a string haystack, so
  // membership on a single-valued field must compile to equality instead.
  it("compiles 'includes an option' to `==`, not `in`", () => {
    const c = defaultConditionForKind("IncludesOption", city);
    expect(c).toEqual({
      TAG: "Comparison",
      fieldId: "city",
      op: "==",
      value: "dar",
    });
  });

  it("compiles 'excludes an option' to `!=`", () => {
    const c = defaultConditionForKind("ExcludesOption", city);
    expect(c).toEqual({
      TAG: "Comparison",
      fieldId: "city",
      op: "!=",
      value: "dar",
    });
  });

  it("compiles 'includes any of' to EqualsAny", () => {
    expect(defaultConditionForKind("IncludesAny", city)).toEqual({
      TAG: "EqualsAny",
      fieldId: "city",
      values: [],
    });
  });

  it("still compiles membership to `in` on a multi-value field", () => {
    expect(defaultConditionForKind("IncludesOption", langs)).toEqual({
      TAG: "IncludesOption",
      fieldId: "langs",
      value: langs.options?.[0]?.value,
    });
  });

  it("presents the equality leaves back as includes / excludes", () => {
    expect(
      displayKindOf(
        { TAG: "Comparison", fieldId: "city", op: "==", value: "dar" },
        city,
      ),
    ).toBe("IncludesOption");
    expect(
      displayKindOf(
        { TAG: "Comparison", fieldId: "city", op: "!=", value: "dar" },
        city,
      ),
    ).toBe("ExcludesOption");
    expect(
      displayKindOf({ TAG: "EqualsAny", fieldId: "city", values: [] }, city),
    ).toBe("IncludesAny");
  });

  it("leaves equality on a non-option field reading as a plain comparison", () => {
    expect(
      displayKindOf(
        { TAG: "Comparison", fieldId: "notes", op: "==", value: "x" },
        notes,
      ),
    ).toBe("Comparison");
  });

  // Switching a row's field across the scalar/multi boundary must rebuild the
  // leaf, not just retarget it: the same "includes any of" row compiles to
  // `or`-of-`==` on one side and `or`-of-`in` on the other.
  it("rebuilds an includes-any row as `in` when retargeted to a multi-value field", () => {
    expect(defaultConditionForKind("IncludesAny", langs)).toEqual({
      TAG: "IncludesAny",
      fieldId: "langs",
      values: [],
    });
  });

  it("rebuilds an includes-any row as equality when retargeted to a select", () => {
    expect(defaultConditionForKind("IncludesAny", city)).toEqual({
      TAG: "EqualsAny",
      fieldId: "city",
      values: [],
    });
  });

  it("compiles each arity's includes-any row to its own operator", () => {
    expect(
      compileVisibilityTemplate({
        TAG: "Conditions",
        connector: "and",
        conditions: [
          { TAG: "EqualsAny", fieldId: "city", values: ["dar", "arusha"] },
        ],
      }),
    ).toEqual({
      or: [
        { "==": [{ var: "form.city" }, "dar"] },
        { "==": [{ var: "form.city" }, "arusha"] },
      ],
    });
    expect(
      compileVisibilityTemplate({
        TAG: "Conditions",
        connector: "and",
        conditions: [
          { TAG: "IncludesAny", fieldId: "langs", values: ["en", "sw"] },
        ],
      }),
    ).toEqual({
      or: [
        { in: ["en", { var: "form.langs" }] },
        { in: ["sw", { var: "form.langs" }] },
      ],
    });
  });

  // Retargeting a row rebuilds the leaf from the new field, so a token
  // stranded by the old field can't follow it across.
  it("drops stale tokens when the row is retargeted to another field", () => {
    expect(defaultConditionForKind("IncludesAny", langs)).toMatchObject({
      values: [],
    });
    expect(defaultConditionForKind("IncludesAny", city)).toMatchObject({
      values: [],
    });
  });

  it("requires at least two picks before an EqualsAny row is valid", () => {
    const fieldList = [city];
    expect(
      conditionValid(
        { TAG: "EqualsAny", fieldId: "city", values: ["dar"] },
        fieldList,
      ),
    ).toBe(false);
    expect(
      conditionValid(
        { TAG: "EqualsAny", fieldId: "city", values: ["dar", "arusha"] },
        fieldList,
      ),
    ).toBe(true);
  });
});

describe("defaultConditionForKind", () => {
  it("seeds IncludesOption with the field's first option value", () => {
    expect(defaultConditionForKind("IncludesOption", langs)).toEqual({
      TAG: "IncludesOption",
      fieldId: "langs",
      value: "en",
    });
  });

  it("starts IncludesAny with an empty values array", () => {
    expect(defaultConditionForKind("IncludesAny", langs)).toEqual({
      TAG: "IncludesAny",
      fieldId: "langs",
      values: [],
    });
  });

  it("resets Comparison to == with an empty value", () => {
    expect(defaultConditionForKind("Comparison", fields[0])).toEqual({
      TAG: "Comparison",
      fieldId: "age",
      op: "==",
      value: "",
    });
  });

  it("seeds LengthCompare with a > 0 bound", () => {
    expect(defaultConditionForKind("LengthCompare", notes)).toEqual({
      TAG: "LengthCompare",
      fieldId: "notes",
      op: ">",
      value: 0,
    });
  });
});

describe("defaultConditionFor", () => {
  it("opens a scalar field on a comparison", () => {
    expect(defaultConditionFor(fields)).toMatchObject({
      TAG: "Comparison",
      fieldId: "age",
    });
  });

  it("opens a multi-value field on IncludesOption", () => {
    expect(defaultConditionFor([langs])).toMatchObject({
      TAG: "IncludesOption",
      fieldId: "langs",
      value: "en",
    });
  });
});

describe("conditionValid — membership kinds", () => {
  const all = [fields[0], langs];

  it("IncludesOption needs a non-empty value", () => {
    expect(
      conditionValid(
        { TAG: "IncludesOption", fieldId: "langs", value: "en" },
        all,
      ),
    ).toBe(true);
    expect(
      conditionValid(
        { TAG: "IncludesOption", fieldId: "langs", value: "" },
        all,
      ),
    ).toBe(false);
  });

  it("IncludesAny / IncludesAll need at least two values", () => {
    expect(
      conditionValid(
        { TAG: "IncludesAny", fieldId: "langs", values: ["en", "sw"] },
        all,
      ),
    ).toBe(true);
    expect(
      conditionValid(
        { TAG: "IncludesAll", fieldId: "langs", values: ["en"] },
        all,
      ),
    ).toBe(false);
  });

  it("Truthy / Falsy just need a valid field reference", () => {
    expect(conditionValid({ TAG: "Truthy", fieldId: "langs" }, all)).toBe(true);
  });

  it("rejects a condition referencing an unknown field", () => {
    expect(
      conditionValid(
        { TAG: "IncludesOption", fieldId: "nope", value: "en" },
        all,
      ),
    ).toBe(false);
  });
});

describe("conditionValid — LengthCompare", () => {
  const all = [notes];

  it("accepts a non-negative integer bound", () => {
    expect(
      conditionValid(
        { TAG: "LengthCompare", fieldId: "notes", op: ">", value: 10 },
        all,
      ),
    ).toBe(true);
    expect(
      conditionValid(
        { TAG: "LengthCompare", fieldId: "notes", op: "<=", value: 0 },
        all,
      ),
    ).toBe(true);
  });

  it("rejects a negative or fractional bound", () => {
    expect(
      conditionValid(
        { TAG: "LengthCompare", fieldId: "notes", op: ">", value: -1 },
        all,
      ),
    ).toBe(false);
    expect(
      conditionValid(
        { TAG: "LengthCompare", fieldId: "notes", op: ">", value: 2.5 },
        all,
      ),
    ).toBe(false);
  });

  it("rejects a length condition on an unknown field", () => {
    expect(
      conditionValid(
        { TAG: "LengthCompare", fieldId: "nope", op: ">", value: 3 },
        all,
      ),
    ).toBe(false);
  });
});

/**
 * Boundary invariants between the TS editor model and the ReScript
 * compiler. `RuleTemplates.compileCondition` reads `.TAG` unguarded, so
 * an `undefined` (or otherwise malformed) entry in a condition list
 * throws inside ReScript, three layers away from wherever it was
 * introduced, and the root catch boundary tears down the whole route.
 * These pin the two funnels that make that unreachable.
 */
describe("condition construction can never yield undefined", () => {
  const shapes: (LogicField | undefined)[] = [undefined];
  for (const multiValue of [undefined, false, true]) {
    for (const options of [
      undefined,
      [],
      [{ value: "a", label: "A" }],
      [{ value: "", label: "blank" }],
    ]) {
      for (const freeText of [undefined, false, true]) {
        shapes.push({
          id: "x",
          displayName: "X",
          kind: "primitive",
          primitiveKind: "string",
          ...(multiValue === undefined ? {} : { multiValue }),
          ...(options === undefined ? {} : { options }),
          ...(freeText === undefined ? {} : { freeText }),
        } as LogicField);
      }
    }
  }

  const leaves: VisibilityCondition[] = [
    { TAG: "Comparison", fieldId: "x", op: "==", value: "a" },
    { TAG: "Comparison", fieldId: "x", op: "!=", value: "a" },
    { TAG: "Comparison", fieldId: "x", op: ">", value: 1 },
    { TAG: "LengthCompare", fieldId: "x", op: ">", value: 1 },
    { TAG: "Truthy", fieldId: "x" },
    { TAG: "Falsy", fieldId: "x" },
    { TAG: "IncludesOption", fieldId: "x", value: "a" },
    { TAG: "ExcludesOption", fieldId: "x", value: "a" },
    { TAG: "IncludesAny", fieldId: "x", values: ["a", "b"] },
    { TAG: "IncludesAll", fieldId: "x", values: ["a", "b"] },
    { TAG: "EqualsAny", fieldId: "x", values: ["a", "b"] },
  ];

  it("conditionKindsFor always offers at least one kind", () => {
    for (const f of shapes) {
      expect(conditionKindsFor(f).length).toBeGreaterThan(0);
      for (const c of leaves) {
        expect(conditionKindsFor(f, c).length).toBeGreaterThan(0);
      }
    }
  });

  it("every offered kind builds a compilable condition on every field shape", () => {
    for (const f of shapes) {
      const kindSets = [
        conditionKindsFor(f),
        ...leaves.map((c) => conditionKindsFor(f, c)),
      ];
      for (const kinds of kindSets) {
        for (const k of kinds) {
          const built = defaultConditionForKind(k, f);
          expect(built).toBeDefined();
          expect(() =>
            compileVisibilityTemplate({
              TAG: "Conditions",
              connector: "and",
              conditions: [built],
            }),
          ).not.toThrow();
        }
      }
    }
  });

  it("every kind a stored leaf displays as is one the model can rebuild", () => {
    for (const f of shapes) {
      for (const c of leaves) {
        expect(defaultConditionForKind(displayKindOf(c, f), f)).toBeDefined();
      }
    }
  });

  it("falls back to a comparison instead of undefined for an out-of-contract kind", () => {
    // `kind` crosses runtime boundaries the type system doesn't police
    // (Radix payloads, persisted rules, a stale bundle). Returning
    // undefined here was what reached ReScript and killed the route.
    const built = defaultConditionForKind(
      "NotAKind" as never,
      { id: "x", displayName: "X", kind: "primitive" } as LogicField,
    );
    expect(built).toEqual({
      TAG: "Comparison",
      fieldId: "x",
      op: "==",
      value: "",
    });
  });
});

describe("templateFromConditions guards the ReScript boundary", () => {
  it("drops malformed entries rather than handing them to the compiler", () => {
    const good: VisibilityCondition = {
      TAG: "Truthy",
      fieldId: "age",
    };
    const t = templateFromConditions(
      [undefined as never, good, null as never],
      "and",
      false,
    );
    expect(t).toEqual({
      TAG: "Conditions",
      connector: "and",
      conditions: [good],
    });
    expect(() => compileVisibilityTemplate(t)).not.toThrow();
  });

  it("collapses to Always when only malformed entries remain", () => {
    expect(templateFromConditions([undefined as never], "and", true)).toBe(
      "Always",
    );
  });

  it("a lone malformed entry compiles to no rule, never a crash", () => {
    const t = templateFromConditions([undefined as never], "and", false);
    expect(compileVisibilityTemplate(t)).toBeUndefined();
  });
});
