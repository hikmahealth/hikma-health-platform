import { describe, it, expect } from "vitest";

import EventForm from "@/models/event-form";
import PatientRegistrationForm from "@/models/patient-registration-form";

/**
 * `toLogicFields` on each form model must surface multi-value fields to the
 * FieldLogicPanel: `multiValue` gates the includes/excludes kinds, `options`
 * feeds the value picker. Event options carry a stable `value`; registration
 * options key on `en` (the token mobile's buildRuleScope resolves back to).
 */

const regField = (
  overrides: Partial<PatientRegistrationForm.Field> = {},
): PatientRegistrationForm.Field => ({
  id: "f",
  position: 1,
  column: "given_name",
  label: { en: "Field" },
  fieldType: "text",
  options: [],
  required: false,
  baseField: false,
  visible: true,
  deleted: false,
  showsInSummary: true,
  isSearchField: false,
  ...overrides,
});

describe("EventForm.toLogicFields — option fields", () => {
  it("marks a multi options field multiValue with value/label options", () => {
    const [lf] = EventForm.toLogicFields([
      {
        id: "sym",
        name: "Symptoms",
        fieldType: "options",
        multi: true,
        options: [
          { label: "Cough", value: "cough" },
          { label: "Fever", value: "fever" },
        ],
      },
    ]);
    expect(lf.multiValue).toBe(true);
    expect(lf.options).toEqual([
      { value: "cough", label: "Cough" },
      { value: "fever", label: "Fever" },
    ]);
  });

  it("emits options for a single-select options field without multiValue", () => {
    const [lf] = EventForm.toLogicFields([
      {
        id: "sev",
        name: "Severity",
        fieldType: "options",
        multi: false,
        options: [{ label: "Low", value: "low" }],
      },
    ]);
    expect(lf.multiValue).toBeUndefined();
    expect(lf.options).toEqual([{ value: "low", label: "Low" }]);
  });

  it("leaves non-option fields without options or multiValue", () => {
    const [lf] = EventForm.toLogicFields([
      { id: "t", name: "Notes", fieldType: "free-text", inputType: "text" },
    ]);
    expect(lf.options).toBeUndefined();
    expect(lf.multiValue).toBeUndefined();
  });

  // Legacy forms store options as bare strings — a shape `ensureOptionIds`
  // and the editor's save path both preserve, so it survives re-saves.
  // Reading `.value` off those produced `{}` entries, which the rule editor
  // rendered as blank, unpickable rows.
  it("normalises bare-string options into value/label pairs", () => {
    const [lf] = EventForm.toLogicFields([
      {
        id: "sev",
        name: "Severity",
        fieldType: "options",
        multi: false,
        options: ["Low", " High "] as never,
      },
    ]);
    expect(lf.options).toEqual([
      { value: "Low", label: "Low" },
      { value: "High", label: "High" },
    ]);
  });

  it("drops options with no usable token rather than emitting blank rows", () => {
    const [lf] = EventForm.toLogicFields([
      {
        id: "sev",
        name: "Severity",
        fieldType: "options",
        multi: false,
        options: [
          { label: "Low", value: "low" },
          { label: "Broken" } as never,
          { label: "Empty", value: "" },
          "" as never,
        ],
      },
    ]);
    expect(lf.options).toEqual([{ value: "low", label: "Low" }]);
  });

  it("falls back to the token as the label when a label is missing", () => {
    const [lf] = EventForm.toLogicFields([
      {
        id: "sev",
        name: "Severity",
        fieldType: "options",
        multi: false,
        options: [{ value: "low" } as never],
      },
    ]);
    expect(lf.options).toEqual([{ value: "low", label: "low" }]);
  });
});

describe("EventForm.toLogicFields — freeText flag", () => {
  it("marks a text free-text field freeText", () => {
    const [lf] = EventForm.toLogicFields([
      { id: "t", name: "Notes", fieldType: "free-text", inputType: "text" },
    ]);
    expect(lf.freeText).toBe(true);
  });

  it("does not mark a numeric free-text field freeText", () => {
    const [lf] = EventForm.toLogicFields([
      { id: "n", name: "Count", fieldType: "free-text", inputType: "number" },
    ]);
    expect(lf.freeText).toBeUndefined();
  });

  it("does not mark binary or option fields freeText", () => {
    const [bin] = EventForm.toLogicFields([{ id: "b", name: "Alive", fieldType: "binary" }]);
    expect(bin.freeText).toBeUndefined();
    const [opt] = EventForm.toLogicFields([
      { id: "s", name: "Severity", fieldType: "options", multi: false, options: [{ label: "Low", value: "low" }] },
    ]);
    expect(opt.freeText).toBeUndefined();
  });
});

describe("PatientRegistrationForm.toLogicFields — option fields", () => {
  it("marks a checkbox multiValue with en-keyed options", () => {
    const [lf] = PatientRegistrationForm.toLogicFields([
      regField({
        id: "langs",
        fieldType: "checkbox",
        options: [{ en: "English" }, { en: "Swahili", ar: "الكسواحيلية" }],
      }),
    ]);
    expect(lf.multiValue).toBe(true);
    expect(lf.options).toEqual([
      { value: "English", label: "English" },
      { value: "Swahili", label: "Swahili" },
    ]);
  });

  it("emits options for a single select without multiValue", () => {
    const [lf] = PatientRegistrationForm.toLogicFields([
      regField({ id: "sex", fieldType: "select", options: [{ en: "male" }, { en: "female" }] }),
    ]);
    expect(lf.multiValue).toBeUndefined();
    expect(lf.options).toEqual([
      { value: "male", label: "male" },
      { value: "female", label: "female" },
    ]);
  });

  it("leaves non-option fields without options or multiValue", () => {
    const [lf] = PatientRegistrationForm.toLogicFields([
      regField({ id: "name", fieldType: "text" }),
    ]);
    expect(lf.options).toBeUndefined();
    expect(lf.multiValue).toBeUndefined();
  });
});

describe("PatientRegistrationForm.toLogicFields — freeText flag", () => {
  it("marks a text field freeText", () => {
    const [lf] = PatientRegistrationForm.toLogicFields([
      regField({ id: "name", fieldType: "text" }),
    ]);
    expect(lf.freeText).toBe(true);
  });

  it("does not mark select / checkbox / number fields freeText", () => {
    const [sel] = PatientRegistrationForm.toLogicFields([
      regField({ id: "sex", fieldType: "select", options: [{ en: "male" }] }),
    ]);
    expect(sel.freeText).toBeUndefined();
    const [chk] = PatientRegistrationForm.toLogicFields([
      regField({ id: "langs", fieldType: "checkbox", options: [{ en: "English" }] }),
    ]);
    expect(chk.freeText).toBeUndefined();
    const [num] = PatientRegistrationForm.toLogicFields([
      regField({ id: "age", fieldType: "number" }),
    ]);
    expect(num.freeText).toBeUndefined();
  });
});
