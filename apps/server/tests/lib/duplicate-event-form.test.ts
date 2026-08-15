import { describe, it, expect } from "vitest";

import EventForm from "@/models/event-form";
import {
  COPY_NAME_SUFFIX,
  duplicateFormContent,
} from "@/lib/duplicate-event-form";
import { ruleReferencesField } from "@hikmahealth/forms/RuleTemplates";

/**
 * A copy must share no id with its source, and every reference to a
 * regenerated id — rule `var` paths, translation keys — must move with it.
 * The first test is the catch-all: no source id survives anywhere in the copy,
 * which fails for any site nobody thought to remap.
 */

const source = () => ({
  form_fields: [
    {
      id: "field-consent",
      _tag: "options",
      fieldType: "options",
      inputType: "select",
      name: "Consent given",
      multi: false,
      options: [
        { id: "opt-yes", label: "Yes", value: "yes" },
        { id: "opt-no", label: "No", value: "no" },
      ],
    },
    {
      id: "field-age",
      _tag: "free-text",
      fieldType: "free-text",
      inputType: "number",
      name: "Age",
      visibleIf: { "==": [{ var: "form.field-consent" }, "yes"] },
      requiredIf: { "!!": { var: "form.field-consent" } },
      validators: [
        {
          id: "validator-age",
          message: "Age must be over 18",
          rule: { ">": [{ var: "form.field-age" }, 18] },
        },
      ],
    },
    {
      id: "field-summary",
      _tag: "free-text",
      fieldType: "free-text",
      inputType: "text",
      name: "Summary",
      computedValue: { cat: [{ var: ["form.field-age", ""] }, " years"] },
    },
  ] as Record<string, unknown>[],
  translations: [
    {
      fieldId: EventForm.FORM_NAME_FIELD_ID,
      name: { es: "Formulario" },
      description: {},
      options: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      fieldId: "field-consent",
      name: { es: "Consentimiento" },
      description: {},
      options: { "opt-yes": { es: "Sí" }, "opt-no": { es: "No" } },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ] as unknown as EventForm.FieldTranslation[],
});

const sourceIds = [
  "field-consent",
  "field-age",
  "field-summary",
  "opt-yes",
  "opt-no",
  "validator-age",
];

describe("duplicateFormContent", () => {
  it("carries no source id into the copy", () => {
    const copy = JSON.stringify(duplicateFormContent(source()));
    for (const id of sourceIds) {
      expect(copy).not.toContain(id);
    }
  });

  it("does not mutate its input", () => {
    const original = source();
    const snapshot = JSON.stringify(original);
    duplicateFormContent(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("repoints every rule at the copy's own fields", () => {
    const { form_fields } = duplicateFormContent(source());
    const [consent, age, summary] = form_fields;

    expect(ruleReferencesField(age.visibleIf, consent.id as string)).toBe(true);
    expect(ruleReferencesField(age.requiredIf, consent.id as string)).toBe(
      true,
    );
    expect(
      ruleReferencesField(
        (age.validators as { rule: unknown }[])[0].rule,
        age.id as string,
      ),
    ).toBe(true);
    expect(ruleReferencesField(summary.computedValue, age.id as string)).toBe(
      true,
    );
  });

  it("keeps option values and labels, replacing only their ids", () => {
    const { form_fields } = duplicateFormContent(source());
    const options = form_fields[0].options as { id: string; value: string }[];

    expect(options.map((o) => o.value)).toEqual(["yes", "no"]);
    expect(new Set(options.map((o) => o.id)).size).toBe(2);
  });

  it("moves translations onto the new field and option ids", () => {
    const { form_fields, translations } = duplicateFormContent(source());
    const consent = form_fields[0];
    const options = consent.options as { id: string }[];

    const fieldTranslation = translations.find((t) => t.fieldId === consent.id);
    expect(fieldTranslation?.name).toEqual({ es: "Consentimiento" });
    expect(fieldTranslation?.options[options[0].id]).toEqual({ es: "Sí" });
    expect(fieldTranslation?.options[options[1].id]).toEqual({ es: "No" });
  });

  // Mobile resolves a form's display name from this entry and only falls back
  // to the `name` column when it is absent, so suffixing the column alone
  // leaves a translated copy sharing its source's name in the form picker.
  it("suffixes every language of the form-name translation", () => {
    const { translations } = duplicateFormContent(source());
    const formName = translations.find(
      (t) => t.fieldId === EventForm.FORM_NAME_FIELD_ID,
    );
    expect(formName?.name).toEqual({ es: `Formulario${COPY_NAME_SUFFIX}` });
  });

  it("leaves an empty form-name translation empty, so the column wins", () => {
    const content = source();
    content.translations = content.translations.map((t) =>
      t.fieldId === EventForm.FORM_NAME_FIELD_ID ? { ...t, name: {} } : t,
    ) as unknown as EventForm.FieldTranslation[];

    const { translations } = duplicateFormContent(content);
    const formName = translations.find(
      (t) => t.fieldId === EventForm.FORM_NAME_FIELD_ID,
    );
    expect(formName?.name).toEqual({});
  });

  it("keeps the form-description translation untouched", () => {
    const content = source();
    content.translations = [
      ...content.translations,
      {
        fieldId: EventForm.FORM_DESCRIPTION_FIELD_ID,
        name: {},
        description: { es: "Una descripción" },
        options: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as EventForm.FieldTranslation[];

    const { translations } = duplicateFormContent(content);
    const formDescription = translations.find(
      (t) => t.fieldId === EventForm.FORM_DESCRIPTION_FIELD_ID,
    );
    expect(formDescription?.description).toEqual({ es: "Una descripción" });
  });

  it("drops translations for fields the form no longer has", () => {
    const content = source();
    content.translations = [
      ...content.translations,
      {
        fieldId: "field-removed",
        name: { es: "Huérfano" },
        description: {},
        options: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as EventForm.FieldTranslation[];

    const { translations } = duplicateFormContent(content);
    expect(translations.map((t) => t.fieldId)).not.toContain("field-removed");
  });

  it("leaves legacy bare-string options untouched", () => {
    const content = source();
    content.form_fields = [
      {
        id: "field-legacy",
        _tag: "medicine",
        fieldType: "medicine",
        name: "Medicine",
        options: ["paracetamol", "ibuprofen"],
      },
    ];
    content.translations = [];

    const { form_fields } = duplicateFormContent(content);
    expect(form_fields[0].options).toEqual(["paracetamol", "ibuprofen"]);
    expect(form_fields[0].id).not.toBe("field-legacy");
  });

  it("keys translations off the option value when legacy options have no id", () => {
    const content = source();
    content.form_fields = [
      {
        id: "field-city",
        _tag: "options",
        fieldType: "options",
        name: "City",
        multi: false,
        options: [{ label: "Dar", value: "dar" }],
      },
    ];
    content.translations = [
      {
        fieldId: "field-city",
        name: {},
        description: {},
        options: { dar: { sw: "Dar" } },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as unknown as EventForm.FieldTranslation[];

    const { form_fields, translations } = duplicateFormContent(content);
    const optionId = (form_fields[0].options as { id: string }[])[0].id;
    expect(translations[0].options[optionId]).toEqual({ sw: "Dar" });
  });

  it("handles a form with no fields or translations", () => {
    expect(duplicateFormContent({ form_fields: [], translations: [] })).toEqual(
      {
        form_fields: [],
        translations: [],
      },
    );
  });
});
