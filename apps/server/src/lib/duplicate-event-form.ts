/**
 * Id regeneration for event-form duplication.
 *
 * A copy must share no id with its source: field ids key the `form_data` of
 * every recorded event, and field and option ids key the `translations`
 * column, so a shared id makes an edit to one form look like an edit to the
 * other's data.
 *
 * Option *values* are left alone — rules embed them as literals and recorded
 * events store them, so they are content, not identity.
 */

import { nanoid } from "nanoid";
import { remapFormFieldRefs } from "@hikmahealth/forms/RuleTemplates";
import EventForm from "@/models/event-form";

/** Fields and translations as they come off the row, already JSON-parsed. */
export type FormContent = {
  form_fields: ReadonlyArray<Record<string, unknown>>;
  translations: ReadonlyArray<EventForm.FieldTranslation>;
};

const RULE_SLOTS = ["visibleIf", "requiredIf", "computedValue"] as const;

/**
 * Appended to a copy's name so it reads as a copy wherever it is shown.
 *
 * Shared with the `name` column rather than duplicated: mobile prefers the
 * `__form_name__` translation over the column and only falls back to it when
 * the translation is absent (`eventFormTranslations.resolveEventFormTranslations`).
 * Suffixing one and not the other leaves a translated form's copy sharing its
 * source's name in the device's form picker.
 */
export const COPY_NAME_SUFFIX = " (Copy)";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const remapRule = (
  rule: unknown,
  fieldIds: Record<string, string>,
): unknown => {
  const remapped = remapFormFieldRefs(rule, fieldIds);
  if (remapped === undefined) {
    throw new Error(
      "A rule in this form is too large to rewrite; the form cannot be duplicated.",
    );
  }
  return remapped;
};

const withRemappedRuleSlots = (
  field: Record<string, unknown>,
  fieldIds: Record<string, string>,
): Record<string, unknown> => {
  const next = { ...field };

  for (const slot of RULE_SLOTS) {
    if (next[slot] === undefined) continue;
    next[slot] = remapRule(next[slot], fieldIds);
  }

  if (Array.isArray(next.validators)) {
    next.validators = next.validators.map((validator: unknown) => {
      if (!isRecord(validator)) return validator;
      return {
        ...validator,
        id: nanoid(),
        rule:
          validator.rule === undefined
            ? validator.rule
            : remapRule(validator.rule, fieldIds),
      };
    });
  }

  return next;
};

/**
 * Fresh ids for a field's object options, keyed by the id its translations
 * used before. Bare-string options carry no id and pass through untouched.
 */
const regenerateOptionIds = (
  options: ReadonlyArray<unknown>,
): { options: unknown[]; optionIds: Record<string, string> } => {
  const optionIds: Record<string, string> = {};
  const regenerated = options.map((option) => {
    if (!isRecord(option)) return option;
    const id = nanoid();
    // Legacy options can lack both `id` and `value`, leaving nothing to key on.
    const previousKey: string | undefined = EventForm.getOptionId(
      option as unknown as EventForm.FieldOption,
    );
    if (typeof previousKey === "string") {
      optionIds[previousKey] = id;
    }
    return { ...option, id };
  });
  return { options: regenerated, optionIds };
};

/**
 * The form-name entry with every language suffixed. An empty map is left
 * empty: mobile reads that as "no translation" and falls back to the `name`
 * column, which already carries the suffix.
 */
const withSuffixedName = (
  translation: EventForm.FieldTranslation,
): EventForm.FieldTranslation => ({
  ...translation,
  name: Object.fromEntries(
    Object.entries(translation.name ?? {}).map(([lang, value]) => [
      lang,
      `${value}${COPY_NAME_SUFFIX}`,
    ]),
  ) as EventForm.FieldTranslation["name"],
});

const remapTranslations = (
  translations: ReadonlyArray<EventForm.FieldTranslation>,
  fieldIds: Record<string, string>,
  optionIdsByField: Record<string, Record<string, string>>,
): EventForm.FieldTranslation[] =>
  translations.flatMap((translation) => {
    // Form-level entries key on sentinel ids, so they carry no field id to
    // remap. Only the name needs rewriting — it is what identifies the form
    // on device, and an unsuffixed copy is indistinguishable from its source.
    if (translation.fieldId === EventForm.FORM_NAME_FIELD_ID) {
      return [withSuffixedName(translation)];
    }
    if (translation.fieldId === EventForm.FORM_DESCRIPTION_FIELD_ID) {
      return [translation];
    }

    const fieldId = fieldIds[translation.fieldId];
    // An orphan entry renders nowhere and would carry a source id into the copy.
    if (fieldId === undefined) return [];

    const optionIds = optionIdsByField[translation.fieldId] ?? {};
    const options: EventForm.FieldTranslation["options"] = {};
    for (const [previousKey, value] of Object.entries(
      translation.options ?? {},
    )) {
      const optionId = optionIds[previousKey];
      if (optionId === undefined) continue;
      options[optionId] = value;
    }

    return [{ ...translation, fieldId, options }];
  });

/**
 * Rebuild a form's fields and translations under freshly generated ids. Does
 * not mutate the input, and the result shares no field, option, or validator
 * id with it. Throws when a rule is too large to rewrite, rather than emitting
 * a copy whose rules still read the source's fields.
 *
 * The form-name translation is suffixed with `COPY_NAME_SUFFIX`; the caller is
 * responsible for suffixing the `name` column to match.
 *
 * A field whose `id` isn't a string is copied verbatim — there is no key to
 * map its rules through.
 */
export function duplicateFormContent(content: FormContent): FormContent {
  const fieldIds: Record<string, string> = {};
  for (const field of content.form_fields) {
    if (typeof field.id === "string") {
      fieldIds[field.id] = nanoid();
    }
  }

  const optionIdsByField: Record<string, Record<string, string>> = {};

  const form_fields = content.form_fields.map((field) => {
    const next = withRemappedRuleSlots(field, fieldIds);

    if (typeof field.id === "string") {
      next.id = fieldIds[field.id];
    }

    if (Array.isArray(field.options)) {
      const { options, optionIds } = regenerateOptionIds(field.options);
      next.options = options;
      if (typeof field.id === "string") {
        optionIdsByField[field.id] = optionIds;
      }
    }

    return next;
  });

  return {
    form_fields,
    translations: remapTranslations(
      content.translations,
      fieldIds,
      optionIdsByField,
    ),
  };
}
