import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Interaction-level coverage for the rule editor's Simple tab.
 *
 * The existing suites test the pure model and the panel's collapse
 * behaviour; nothing drove the pickers, which is where a
 * "TypeError: can't access property TAG, c is undefined" crash
 * (RuleTemplates.compileCondition ← evaluateSimpleTemplate ← RuleEditor)
 * came from. An `undefined` in the condition list is unrenderable AND
 * uncompilable, so it takes down the whole route via the root catch
 * boundary; these tests pin the invariant that no interaction can put
 * one there.
 *
 * Radix `Select` can't be driven under jsdom (pointer capture, portals),
 * so it's swapped for a native `<select>` honouring the same props
 * contract — `value` + `onValueChange`, options from `SelectItem`
 * children. Everything below that (SimpleRuleInput, RuleEditor,
 * rule-model, and the ReScript compiler) is the real thing.
 */
vi.mock("@/components/ui/select", () => {
  const React = require("react");
  const collect = (node: any, out: { value: string; label: string }[]) => {
    React.Children.forEach(node, (child: any) => {
      if (!React.isValidElement(child)) return;
      const p: any = child.props;
      if (p && typeof p.value === "string" && p.children !== undefined) {
        out.push({ value: p.value, label: String(p.children) });
      } else if (p?.children) {
        collect(p.children, out);
      }
    });
  };
  return {
    Select: ({ value, onValueChange, children, ...rest }: any) => {
      const items: { value: string; label: string }[] = [];
      collect(children, items);
      let testId: string | undefined;
      const findTrigger = (node: any) => {
        React.Children.forEach(node, (child: any) => {
          if (!React.isValidElement(child)) return;
          const p: any = child.props;
          if (p?.["data-testid"]) testId = p["data-testid"];
          else if (p?.children) findTrigger(p.children);
        });
      };
      findTrigger(children);
      return React.createElement(
        "select",
        {
          "data-testid": testId,
          // Radix shows a placeholder for an unmatched value; the sentinel
          // keeps React from warning about a controlled select with no
          // matching option. It is never offered as an action.
          value: value === undefined || value === "" ? "__none__" : value,
          onChange: (e: any) => onValueChange?.(e.currentTarget.value),
          ...rest,
        },
        [
          React.createElement(
            "option",
            { key: "__empty", value: "__none__" },
            "",
          ),
          ...items.map((i, ix) =>
            React.createElement(
              "option",
              { key: `${i.value}-${ix}`, value: i.value },
              i.label,
            ),
          ),
        ],
      );
    },
    SelectContent: ({ children }: any) => children,
    SelectGroup: ({ children }: any) => children,
    SelectItem: ({ children }: any) => children,
    SelectLabel: ({ children }: any) => children,
    SelectSeparator: () => null,
    SelectTrigger: ({ children }: any) => children,
    SelectValue: () => null,
    SelectScrollUpButton: () => null,
    SelectScrollDownButton: () => null,
  };
});

import { FieldLogicPanel } from "@/components/form-builder/FieldLogicPanel";
import { SimpleRuleInput } from "@/components/form-builder/field-logic/SimpleRuleInput";
import { VALIDATOR_KIND_LABELS } from "@/components/form-builder/field-logic/rule-model";
import EventForm from "@/models/event-form";

const opt = (v: string, l: string) => ({ id: `o-${v}`, label: l, value: v });

const RAW = [
  { id: "f_text", name: "Note", fieldType: "free-text", inputType: "text" },
  { id: "f_num", name: "Age", fieldType: "free-text", inputType: "number" },
  { id: "f_date", name: "Visit date", fieldType: "date" },
  { id: "f_bin", name: "Consent", fieldType: "binary" },
  {
    id: "f_sel",
    name: "Severity",
    fieldType: "options",
    inputType: "select",
    multi: false,
    options: [opt("low", "Low"), opt("high", "High")],
  },
  {
    id: "f_multi",
    name: "Symptoms",
    fieldType: "options",
    inputType: "select",
    multi: true,
    options: [opt("cough", "Cough"), opt("fever", "Fever")],
  },
  {
    id: "f_sel_empty",
    name: "Empty select",
    fieldType: "options",
    inputType: "select",
    multi: false,
    options: [],
  },
  {
    // Legacy shape: options stored as bare strings (see ensureOptionIds).
    id: "f_sel_legacy",
    name: "Legacy severity",
    fieldType: "options",
    inputType: "select",
    multi: false,
    options: ["Mild", "Severe"],
  },
  { id: "f_med", name: "Meds", fieldType: "medicine" },
  { id: "f_target", name: "Target", fieldType: "free-text", inputType: "text" },
] as never;

const fields = EventForm.toLogicFields(RAW);

const openPanel = (initial?: object) => {
  render(
    <FieldLogicPanel
      form={fields}
      fieldId="f_target"
      initial={initial ? { visibleIf: initial as never } : {}}
      onSave={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Logic & Validation"));
};

describe("visibility rule: show a field when a select has a value", () => {
  it("builds the rule end to end", () => {
    const onSave = vi.fn();
    render(
      <FieldLogicPanel
        form={fields}
        fieldId="f_target"
        initial={{}}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Logic & Validation"));
    fireEvent.click(screen.getByTestId("visibility-section-toggle"));
    fireEvent.click(screen.getByTestId("rule-add-condition"));

    // Point the condition at the select field; the row swaps from a raw
    // comparison to the option picker.
    fireEvent.change(screen.getByTestId("rule-field-picker"), {
      target: { value: "f_sel" },
    });
    expect((screen.getByTestId("rule-when-kind") as HTMLSelectElement).value).toBe(
      "IncludesOption",
    );

    fireEvent.change(screen.getByTestId("rule-option"), {
      target: { value: "high" },
    });
    fireEvent.click(screen.getByTestId("rule-save"));

    // A single-valued select compiles to equality, never `in` — see the
    // note on EqualsAny in RuleTemplates.res.
    expect(onSave).toHaveBeenCalledWith({
      visibleIf: { "==": [{ var: "form.f_sel" }, "high"] },
    });
  });

  it("builds the same rule on a legacy string-options select", () => {
    const onSave = vi.fn();
    render(
      <FieldLogicPanel
        form={fields}
        fieldId="f_target"
        initial={{}}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Logic & Validation"));
    fireEvent.click(screen.getByTestId("visibility-section-toggle"));
    fireEvent.click(screen.getByTestId("rule-add-condition"));
    fireEvent.change(screen.getByTestId("rule-field-picker"), {
      target: { value: "f_sel_legacy" },
    });
    fireEvent.change(screen.getByTestId("rule-option"), {
      target: { value: "Severe" },
    });
    fireEvent.click(screen.getByTestId("rule-save"));
    expect(onSave).toHaveBeenCalledWith({
      visibleIf: { "==": [{ var: "form.f_sel_legacy" }, "Severe"] },
    });
  });

  it("survives switching the referenced field between every field shape", () => {
    const ids = (fields as { id: string; kind: string }[])
      .filter((f) => f.kind === "primitive")
      .map((f) => f.id);
    for (const from of ids) {
      for (const to of ids) {
        cleanup();
        openPanel();
        fireEvent.click(screen.getByTestId("visibility-section-toggle"));
        fireEvent.click(screen.getByTestId("rule-add-condition"));
        fireEvent.change(screen.getByTestId("rule-field-picker"), {
          target: { value: from },
        });
        fireEvent.change(screen.getByTestId("rule-field-picker"), {
          target: { value: to },
        });
        // Then every kind the row now offers.
        const kindSel = screen.getByTestId(
          "rule-when-kind",
        ) as HTMLSelectElement;
        for (const k of Array.from(kindSel.options)
          .map((o) => o.value)
          .filter((v) => v !== "__none__")) {
          fireEvent.change(screen.getByTestId("rule-when-kind"), {
            target: { value: k },
          });
        }
        expect(screen.getByTestId("condition-row-0")).toBeDefined();
      }
    }
  });
});

// Stored rules the editor may open on: one per leaf kind, plus groups and
// a dangling field reference.
const INITIAL_RULES: (object | undefined)[] = [
  undefined,
  { "==": [{ var: "form.f_sel" }, "high"] },
  { ">": [{ var: "form.f_num" }, 3] },
  { "!!": { var: "form.f_text" } },
  { in: ["cough", { var: "form.f_multi" }] },
  { "!": { in: ["cough", { var: "form.f_multi" }] } },
  {
    or: [
      { in: ["cough", { var: "form.f_multi" }] },
      { in: ["fever", { var: "form.f_multi" }] },
    ],
  },
  {
    or: [
      { "==": [{ var: "form.f_sel" }, "low"] },
      { "==": [{ var: "form.f_sel" }, "high"] },
    ],
  },
  { ">": [{ length: { var: ["form.f_text", ""] } }, 5] },
  {
    and: [
      { "==": [{ var: "form.f_sel" }, "high"] },
      { "!!": { var: "form.f_text" } },
    ],
  },
  { "==": [{ var: "form.f_gone" }, "x"] },
];

// Deterministic PRNG so a failure reproduces from its seed.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: T[]): T =>
  xs[Math.floor(r() * xs.length)];

const TRACE: string[] = [];

// One random interaction against whatever the editors currently render.
function step(r: () => number) {
  const actions: [string, () => void][] = [];

  screen.queryAllByTestId("rule-add-condition").forEach((add, i) => {
    actions.push([`add-condition[${i}]`, () => fireEvent.click(add)]);
  });
  screen.queryAllByTestId("condition-remove").forEach((el, i) => {
    actions.push([`remove-condition[${i}]`, () => fireEvent.click(el)]);
  });
  for (const sel of [
    ...screen.queryAllByTestId("rule-field-picker"),
    ...screen.queryAllByTestId("rule-when-kind"),
    ...screen.queryAllByTestId("rule-option"),
    ...screen.queryAllByTestId("rule-operator"),
    ...screen.queryAllByTestId("rule-length-operator"),
    ...screen.queryAllByTestId("rule-connector"),
    ...screen.queryAllByTestId("rule-value"),
  ] as HTMLSelectElement[]) {
    const opts = Array.from(sel.options ?? [])
      .map((o) => o.value)
      .filter((v) => v !== "__none__");
    if (opts.length === 0) continue;
    const v = pick(r, opts);
    actions.push([
      `${sel.getAttribute("data-testid")}=${v}`,
      () => fireEvent.change(sel, { target: { value: v } }),
    ]);
  }
  for (const cb of screen.queryAllByTestId(/^rule-option-/)) {
    actions.push([
      `toggle ${cb.getAttribute("data-testid")}`,
      () => fireEvent.click(cb),
    ]);
  }
  for (const input of screen.queryAllByTestId("rule-length-value")) {
    const n = String(Math.floor(r() * 9));
    actions.push([
      `length=${n}`,
      () => fireEvent.change(input, { target: { value: n } }),
    ]);
  }
  if (actions.length === 0) return;
  const [label, run] = pick(r, actions);
  TRACE.push(label);
  run();
}

describe("random walk over every rule section", () => {
  for (let seed = 1; seed <= 6; seed++) {
    it(`seed ${seed} never produces an uncompilable template`, () => {
      const r = rng(seed);
      for (const initial of INITIAL_RULES) {
        cleanup();
        TRACE.length = 0;
        TRACE.push(`initial=${JSON.stringify(initial)}`);
        openPanel(initial);
        fireEvent.click(screen.getByTestId("visibility-section-toggle"));
        fireEvent.click(screen.getByTestId("required-if-section-toggle"));
        fireEvent.click(screen.getByTestId("validators-section-toggle"));
        fireEvent.click(screen.getByTestId("validators-add"));
        for (let i = 0; i < 30; i++) {
          try {
            step(r);
          } catch (e) {
            throw new Error(`TRACE:\n${TRACE.join("\n")}\n--- ${String(e)}`);
          }
        }
      }
    });
  }
});

describe("single-condition surface (validators)", () => {
  it("keeps the first edit to a row synthesised over an empty list", () => {
    // `allowMultiple: false` renders one row, falling back to
    // `defaultConditionFor` when the template carries no conditions. That
    // row's first edit targets index 0 of an empty list, which `[].map`
    // silently discarded.
    const onTemplateChange = vi.fn();
    render(
      <SimpleRuleInput
        referenceableFields={fields}
        template={{ TAG: "Conditions", connector: "and", conditions: [] }}
        onTemplateChange={onTemplateChange}
        allowAlways={false}
        allowMultiple={false}
        kindLabels={VALIDATOR_KIND_LABELS}
      />,
    );
    fireEvent.change(screen.getByTestId("rule-field-picker"), {
      target: { value: "f_num" },
    });
    expect(onTemplateChange).toHaveBeenCalledWith({
      TAG: "Conditions",
      connector: "and",
      conditions: [
        { TAG: "Comparison", fieldId: "f_num", op: "==", value: "" },
      ],
    });
  });
});
