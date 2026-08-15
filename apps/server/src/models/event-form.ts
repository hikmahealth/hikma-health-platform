import { Data, Either, Schema } from "effect";
import type {
  ColumnType,
  Generated,
  Selectable,
  Insertable,
  Updateable,
  JSONColumnType,
} from "kysely";
import { sql } from "kysely";
import { createServerOnlyFn } from "@tanstack/react-start";
import { safeJSONParse } from "@/lib/utils";
import db from "@/db";
import { v1 as uuidV1 } from "uuid";
import Language from "@/models/language";
import { nanoid } from "nanoid";
import type {
  FieldRuleSlots,
  JsonLogicRule,
  Validator,
  WithVisibility,
  WithInputRules,
} from "@/models/form-rules";
import { assertFieldRulesValid } from "@/models/form-rules";
import type {
  LogicField,
  LogicFieldKind,
  LogicOption,
  LogicPrimitiveKind,
} from "@/lib/form-rule-templates";

namespace EventForm {
  // export type T = {
  //   id: string;
  //   name: Option.Option<string>;
  //   description: Option.Option<string>;
  //   language: string;
  //   is_editable: boolean;
  //   is_snapshot_form: boolean;
  //   form_fields: any[];
  //   metadata: Record<string, any>;
  //   is_deleted: boolean;
  //   created_at: Date;
  //   updated_at: Date;
  //   last_modified: Date;
  //   server_created_at: Date;
  //   deleted_at: Option.Option<Date>;
  // };

  export namespace Table {
    export const name = "event_forms";
    export const mobileName = "event_forms";
    export const columns = {
      id: "id",
      name: "name",
      description: "description",
      language: "language",
      is_editable: "is_editable",
      is_snapshot_form: "is_snapshot_form",
      form_fields: "form_fields",
      metadata: "metadata",
      clinic_ids: "clinic_ids",
      translations: "translations",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
    };

    export interface T {
      id: string;
      name: string | null;
      description: string | null;
      language: Generated<string>;
      is_editable: Generated<boolean>;
      is_snapshot_form: Generated<boolean>;
      form_fields: JSONColumnType<any[]>;
      metadata: JSONColumnType<Record<string, any>>;
      clinic_ids: JSONColumnType<string[]>;
      translations: Generated<JSONColumnType<FieldTranslation[]>>;
      is_deleted: Generated<boolean>;
      created_at: Generated<ColumnType<Date, string | undefined, never>>;
      updated_at: Generated<
        ColumnType<Date, string | undefined, string | undefined>
      >;
      last_modified: Generated<ColumnType<Date, string | undefined, never>>;
      server_created_at: Generated<ColumnType<Date, string | undefined, never>>;
      deleted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
    }

    export type EventForms = Selectable<T>;
    export type NewEventForms = Insertable<T>;
    export type EventFormsUpdate = Updateable<T>;
  }

  export const RESERVED_FIELD_NAMES = ["diagnosis", "medicine"];

  // INPUT TYPES FOR CUSTOM FORMS & WORKFLOWS
  export type InputType =
    | "text"
    | "textarea"
    | "number"
    | "email"
    | "password"
    | "date"
    | "time"
    | "datetime"
    | "checkbox"
    | "radio"
    | "select"
    | "file"
    | "image"
    | "url"
    | "tel"
    | "color"
    | "range"
    | "hidden"
    | "submit"
    | "reset"
    | "button"
    | "search"
    | "month"
    | "week"
    | "datetime-local"
    | "custom";

  export type FieldType =
    | "binary"
    | "medicine"
    | "diagnosis"
    | "dosage"
    | "free-text"
    | "input-group"
    | "file"
    | "options"
    | "date"
    | "text"
    | "separator"
    | "custom";

  export const textDisplaySizes = ["xxl", "xl", "lg", "md", "sm"] as const;
  export type TextDisplaySize = (typeof textDisplaySizes)[number];

  export interface HHFieldBase {
    id: string;
    name: string;
    description: string;
    required: boolean;
  }

  export const durationUnits = [
    "hours",
    "days",
    "weeks",
    "months",
    "years",
  ] as const;
  export type DurationUnit = (typeof durationUnits)[number];

  export const measurementUnits = [
    "cm",
    "m",
    "kg",
    "lb",
    "in",
    "ft",
    "mmHg",
    "cmH2O",
    "mmH2O",
    "°C",
    "°F",
    "BPM",
    "P",
    "mmol/L",
    "mg/dL",
    "%",
    "units",
  ] as const;
  export type MeasurementUnit = (typeof measurementUnits)[number];

  export const doseUnits = ["mg", "g", "mcg", "mL", "L", "units"] as const;
  export type DoseUnit = (typeof doseUnits)[number];

  export const medicineRoutes = [
    "oral",
    "sublingual",
    "rectal",
    "topical",
    "inhalation",
    "intravenous",
    "intramuscular",
    "intradermal",
    "subcutaneous",
    "nasal",
    "ophthalmic",
    "otic",
    "vaginal",
    "transdermal",
    "other",
  ] as const;
  export type MedicineRoute = (typeof medicineRoutes)[number];

  export const medicineForms = [
    "tablet",
    "syrup",
    "ampule",
    "suppository",
    "cream",
    "drops",
    "bottle",
    "spray",
    "gel",
    "lotion",
    "inhaler",
    "capsule",
    "injection",
    "patch",
    "other",
  ] as const;
  export type MedicineForm = (typeof medicineForms)[number];

  export type FieldOption = {
    id?: string;
    label: string;
    value: string;
  };

  // TRANSLATIONS

  /** Sentinel field IDs for form-level translations */
  export const FORM_NAME_FIELD_ID = "__form_name__";
  export const FORM_DESCRIPTION_FIELD_ID = "__form_description__";

  export type FieldTranslation = {
    fieldId: string;
    name: Language.TranslationObject;
    description: Language.TranslationObject;
    options: Record<string, Language.TranslationObject>;
    createdAt: string;
    updatedAt: string;
  };

  /** Get the translation ID for an option, falling back to value for old data without IDs */
  export function getOptionId(option: FieldOption): string {
    return option.id ?? option.value;
  }

  /** Add nanoid IDs to any options that are missing them. Idempotent. */
  export function ensureOptionIds(fields: any[]): any[] {
    return fields.map((field) => {
      if (!field.options || !Array.isArray(field.options)) return field;
      const options = field.options.map((opt: any) => {
        if (typeof opt === "string") return opt;
        return opt.id ? opt : { ...opt, id: nanoid() };
      });
      return { ...field, options };
    });
  }

  /** Find the translation entry for a given fieldId */
  export function getFieldTranslation(
    translations: FieldTranslation[],
    fieldId: string,
  ): FieldTranslation | undefined {
    return translations.find((t) => t.fieldId === fieldId);
  }

  /** Upsert a translation value for a field's name or description */
  export function upsertFieldTranslation(
    translations: FieldTranslation[],
    fieldId: string,
    lang: string,
    key: "name" | "description",
    value: string,
  ): FieldTranslation[] {
    const now = new Date().toISOString();
    const existing = translations.find((t) => t.fieldId === fieldId);
    if (existing) {
      return translations.map((t) =>
        t.fieldId === fieldId
          ? { ...t, [key]: { ...t[key], [lang]: value }, updatedAt: now }
          : t,
      );
    }
    const entry: FieldTranslation = {
      fieldId,
      name: {} as Language.TranslationObject,
      description: {} as Language.TranslationObject,
      options: {},
      createdAt: now,
      updatedAt: now,
    };
    entry[key] = { [lang]: value } as Language.TranslationObject;
    return [...translations, entry];
  }

  /** Upsert a translation value for a specific option within a field */
  export function upsertOptionTranslation(
    translations: FieldTranslation[],
    fieldId: string,
    optionId: string,
    lang: string,
    value: string,
  ): FieldTranslation[] {
    const now = new Date().toISOString();
    const existing = translations.find((t) => t.fieldId === fieldId);
    if (existing) {
      return translations.map((t) => {
        if (t.fieldId !== fieldId) return t;
        const optTranslation =
          t.options[optionId] ?? ({} as Language.TranslationObject);
        return {
          ...t,
          options: {
            ...t.options,
            [optionId]: { ...optTranslation, [lang]: value },
          },
          updatedAt: now,
        };
      });
    }
    const entry: FieldTranslation = {
      fieldId,
      name: {} as Language.TranslationObject,
      description: {} as Language.TranslationObject,
      options: { [optionId]: { [lang]: value } as Language.TranslationObject },
      createdAt: now,
      updatedAt: now,
    };
    return [...translations, entry];
  }

  /** Remove translation entries for a given fieldId */
  export function removeFieldTranslation(
    translations: FieldTranslation[],
    fieldId: string,
  ): FieldTranslation[] {
    return translations.filter((t) => t.fieldId !== fieldId);
  }

  // ==========================================================================
  // TOMBSTONE — commented out 2026-07-26 · DELETE AFTER 2027-01-26
  //
  // The pre-`Field`/`FieldData` plain-type field model: BinaryField,
  // OptionsField, DiagnosisField, TextField, MedicineField, DateField, the
  // `HHField` union, `HHFieldWithPosition`, and the `Fields` namespace
  // (hasUnits/getUnits). Superseded by the `*Field2` TaggedClasses and
  // `FieldSchema` below, which every live consumer already uses.
  //
  // References at tombstone time, all retired alongside — no production caller
  // existed for any of them:
  //   - `forms/builder-context.tsx`, `forms/components/input.tsx` and
  //     `forms/components-registry.tsx`: an unreachable subtree (the registry is
  //     imported by nothing and is the only importer of `input.tsx`), tombstoned
  //     as whole files.
  //   - `tests/models/event-form-schema.test.ts`: four tests over `Fields`
  //     (`hasUnits`/`getUnits`) and two `HHField` fixtures, tombstoned in place.
  //     `packages/hh-forms`' `getUnitsOpt` is the live replacement and carries
  //     equivalent tests.
  // Note `InputSettingsList.tsx` imports a *same-named* `HHFieldWithPosition`
  // from `components/types/Inputs` — a different module, unaffected. Likewise
  // every `EventForm.*Field2` reference is the live TaggedClass, not these.
  //
  // Search `tests/` as well as `src/` before concluding one of these is unused:
  // the `Fields` helpers looked dead in `src/` and had four passing tests.
  //
  // Commented rather than deleted so the shape stays readable while any
  // straggler surfaces. Do not treat "it still compiles" as proof these are
  // unused: `tsc -p .` in this app checks zero files (project-reference config
  // errors) and types are erased at build time, so a forgotten reference is
  // neither a CI failure nor a runtime error. A real bug proved it — `fieldType`
  // was dropped from one member of both `OptionsField` and `TextField`,
  // un-discriminating both unions, and produced no error anywhere. `getUnits`
  // carried a standing `units`-does-not-exist error for the same reason.
  //
  // If nothing has needed these by the date above, delete the blocks outright.
  // ==========================================================================

  // export type BinaryField = HHFieldBase &
  //   WithInputRules & {
  //     fieldType: "binary";
  //     inputType: "checkbox" | "radio" | "select";
  //     options: FieldOption[];
  //   };

  // `fieldType` is hoisted out of the union rather than repeated in each
  // member: it is the discriminant `HHField` narrows on, and a copy per member
  // is one reindent away from being dropped from one of them — which silently
  // un-discriminates the whole union.
  // export type OptionsField = HHFieldBase &
  //   WithInputRules & { fieldType: "options" } & (
  //     | {
  //         inputType: "radio";
  //         multi: false;
  //         options: FieldOption[];
  //       }
  //     | {
  //         inputType: "checkbox" | "select";
  //         multi: boolean;
  //         options: FieldOption[];
  //       }
  //   );

  // Diagnoses / medicines / files collect bulk data via custom UIs and
  // their value-shape isn't a single primitive — only `visibleIf` makes
  // sense for now. `requiredIf`/`validators`/`computedValue` are
  // intentionally omitted until the renderer can model them.
  // export type DiagnosisField = HHFieldBase &
  //   WithVisibility & {
  //     fieldType: "diagnosis";
  //     inputType: "select";
  //     options: FieldOption[];
  //   };

  // `fieldType` hoisted out of the union — see the note on `OptionsField`.
  // export type TextField = HHFieldBase &
  //   WithInputRules & { fieldType: "free-text" } & (
  //     | {
  //         inputType: "text" | "number" | "email" | "password" | "tel";
  //         length: "short";
  //         units?: DoseUnit[] | DurationUnit[];
  //       }
  //     | {
  //         inputType: "textarea";
  //         length: "long";
  //         units?: DoseUnit[] | DurationUnit[];
  //       }
  //   );

  export type MedicineFieldOptions = string[] | FieldOption[];

  // TOMBSTONE 2026-07-26 — see the banner above. (`MedicineFieldOptions` just
  // above stays: `MedicineField2` still uses it.)
  // export type MedicineField = HHFieldBase &
  //   WithVisibility & {
  //     fieldType: "medicine";
  //     inputType: "input-group";
  //     options: MedicineFieldOptions;
  //     fields: {
  //       name: TextField;
  //       route: MedicineRoute;
  //       form: MedicineForm;
  //       frequency: TextField;
  //       intervals: TextField;
  //       dose: TextField;
  //       doseUnits: DoseUnit;
  //       duration: TextField;
  //       durationUnits: DurationUnit;
  //     };
  //   };

  type MedicationEntry = {
    name: string;
    route: MedicineRoute;
    form: MedicineForm;
    frequency: number;
    intervals: number;
    dose: number;
    doseUnits: DoseUnit;
    duration: number;
    durationUnits: DurationUnit;
  };

  // TOMBSTONE 2026-07-26 — see the banner above. (`MedicationEntry` just above
  // stays: it is independent of this cluster.)
  // export type DateField = HHFieldBase &
  //   WithInputRules & {
  //     fieldType: "date";
  //     inputType: "date";
  //     min?: Date;
  //     max?: Date;
  //   };

  // export type HHField =
  //   | BinaryField
  //   | TextField
  //   | MedicineField
  //   | DiagnosisField
  //   | DateField
  //   | OptionsField;
  // // | FileField;

  export const BaseFieldSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    required: Schema.Boolean,
  });

  // Effect-schema fragments mirroring the rule slots in
  // @/models/form-rules. JSONLogic rules are opaque JSON
  // (`Schema.Unknown`); their deeper structure is checked by
  // `@nd/jsonlogic`'s `validate` at authoring time. All slots are
  // optional to keep the wire shape additive — legacy forms without
  // rules continue to decode unchanged.
  const ValidatorSchema = Schema.Struct({
    id: Schema.String,
    rule: Schema.Unknown,
    message: Schema.String,
    code: Schema.optional(Schema.String),
  });

  // For diagnosis / medicine / file / display-only fields: visibility
  // is the only supported slot for now.
  const VisibilityRulesSchema = Schema.Struct({
    visibleIf: Schema.optional(Schema.Unknown),
  });

  // For input-collecting fields (binary / free-text / date / options):
  // all four slots are supported.
  const InputFieldRulesSchema = Schema.Struct({
    visibleIf: Schema.optional(Schema.Unknown),
    requiredIf: Schema.optional(Schema.Unknown),
    validators: Schema.optional(Schema.Array(ValidatorSchema)),
    computedValue: Schema.optional(Schema.Unknown),
  });

  export class BinaryField2 extends Data.TaggedClass("binary")<
    {
      inputType: "checkbox" | "radio" | "select";
      options: FieldOption[];
    } & HHFieldBase &
      WithInputRules
  > {
    readonly fieldType = "binary" as const;
  }

  export class TextField2 extends Data.TaggedClass("free-text")<
    {
      fieldType: "free-text";
      inputType: "text" | "number" | "email" | "password" | "tel";
      length: "short" | "long";
      units: DoseUnit[] | DurationUnit[];
    } & HHFieldBase &
      WithInputRules
  > {
    readonly fieldType = "free-text" as const;
  }

  export class MedicineField2 extends Data.TaggedClass("medicine")<
    {
      inputType: "input-group";
      options: MedicineFieldOptions;
      fields: {
        name: string;
        route: string[];
        form: string[];
        frequency: string;
        intervals: string;
        dose: string;
        doseUnits: DoseUnit[];
        duration: string;
        durationUnits: DurationUnit[];
      };
    } & HHFieldBase &
      WithVisibility
  > {
    readonly fieldType = "medicine" as const;
  }

  export class DiagnosisField2 extends Data.TaggedClass("diagnosis")<
    {
      inputType: "select";
      options: FieldOption[];
      // Whether or not to add this entry to the patient's problems list
      // (conditions/etc). Absent on forms authored before the flag existed,
      // which the mobile client reads as "do not record".
      addToProblems?: boolean;
    } & HHFieldBase &
      WithVisibility
  > {
    readonly fieldType = "diagnosis" as const;
  }

  export class DateField2 extends Data.TaggedClass("date")<
    {
      inputType: "date";
    } & HHFieldBase &
      WithInputRules
  > {
    readonly fieldType = "date" as const;
  }

  export class OptionsField2 extends Data.TaggedClass("options")<
    {
      fieldType: "options";
      inputType: "radio" | "checkbox" | "select";
      multi: boolean;
      options: FieldOption[];
    } & HHFieldBase &
      WithInputRules
  > {
    readonly fieldType = "options" as const;
  }

  export class FileField2 extends Data.TaggedClass("file")<
    {
      // NOTE: need to keep in mind old usage had a union of "file" | "image"
      // fieldType: "file" | "image";
      inputType: "file";
      allowedMimeTypes:
        ("image/png" | "image/jpeg" | "application/pdf")[] | null;
      multiple: boolean;
      minItems: number;
      maxItems: number;
    } & HHFieldBase &
      WithVisibility
  > {
    readonly fieldType = "file" as const;
  }

  export class TextDisplayField2 extends Data.TaggedClass("text")<
    {
      content: string;
      size: TextDisplaySize;
    } & HHFieldBase &
      WithVisibility
  > {
    readonly fieldType = "text" as const;
  }

  export class SeparatorField2 extends Data.TaggedClass("separator")<
    HHFieldBase & WithVisibility
  > {
    readonly fieldType = "separator" as const;
  }

  /**
   * Ceiling on files per field, bounding what an author can commit a clinician
   * to uploading from a phone over clinic bandwidth.
   */
  export const FILE_FIELD_ITEMS_MAX = 20;

  /**
   * Apply an edit to a file field's item bounds, keeping the pair coherent:
   * `1 <= maxItems <= FILE_FIELD_ITEMS_MAX` and `0 <= minItems <= maxItems`.
   *
   * The edited bound wins and the other yields, so dragging `minItems` above
   * `maxItems` raises the ceiling rather than silently discarding the input.
   * Non-numeric input (an emptied number field) leaves that bound unchanged.
   */
  export function withFileItemBounds(
    current: { minItems: number; maxItems: number },
    change: { minItems?: number; maxItems?: number },
  ): { minItems: number; maxItems: number } {
    const clamp = (value: number, low: number, high: number): number =>
      Math.min(Math.max(Math.trunc(value), low), high);

    const currentMax = clamp(current.maxItems, 1, FILE_FIELD_ITEMS_MAX);
    const currentMin = clamp(current.minItems, 0, currentMax);

    if (Number.isFinite(change.maxItems)) {
      const maxItems = clamp(
        change.maxItems as number,
        1,
        FILE_FIELD_ITEMS_MAX,
      );
      return { minItems: Math.min(currentMin, maxItems), maxItems };
    }

    if (Number.isFinite(change.minItems)) {
      const minItems = clamp(
        change.minItems as number,
        0,
        FILE_FIELD_ITEMS_MAX,
      );
      return { minItems, maxItems: Math.max(currentMax, minItems, 1) };
    }

    return { minItems: currentMin, maxItems: currentMax };
  }

  export const FieldOptionSchema = Schema.Struct({
    id: Schema.optional(Schema.String),
    label: Schema.String,
    value: Schema.String,
  });

  export const createFieldSchema = <T extends string, A, I, R>(
    tag: T,
    specific: Schema.Schema<A, I, R>,
  ) =>
    Schema.Struct({
      _tag: Schema.Literal(tag),
      fieldType: Schema.Literal(tag),
    }).pipe(Schema.extend(specific), Schema.extend(BaseFieldSchema));

  /**
   * The `_tag` for a field type. `createFieldSchema` derives both discriminants
   * from the same literal, so the two are always the same string; this exists
   * to graft `_tag` onto plain field objects loaded from storage, which the
   * encoder still requires.
   */
  export const getFieldTag = (fieldType: Field["fieldType"]): Field["_tag"] =>
    fieldType;

  export const BinaryFieldSchema = createFieldSchema(
    "binary",
    Schema.Struct({
      inputType: Schema.Union(
        Schema.Literal("checkbox"),
        Schema.Literal("radio"),
        Schema.Literal("select"),
      ),
      options: Schema.Array(FieldOptionSchema),
    }),
  ).pipe(Schema.extend(InputFieldRulesSchema));

  export const TextFieldSchema = createFieldSchema(
    "free-text",
    Schema.Struct({
      inputType: Schema.Union(
        Schema.Literal("text"),
        Schema.Literal("number"),
        Schema.Literal("email"),
        Schema.Literal("password"),
        Schema.Literal("tel"),
      ),
      length: Schema.Union(Schema.Literal("short"), Schema.Literal("long")),
      units: Schema.Array(
        Schema.Union(
          Schema.Literal("mg"),
          Schema.Literal("g"),
          Schema.Literal("mcg"),
          Schema.Literal("mL"),
          Schema.Literal("L"),
          Schema.Literal("units"),
        ),
      ),
    }),
  ).pipe(Schema.extend(InputFieldRulesSchema));
  export const MedicineFieldSchema = createFieldSchema(
    "medicine",
    Schema.Struct({
      inputType: Schema.Literal("input-group"),
      options: Schema.Array(FieldOptionSchema),
      fields: Schema.Struct({
        name: Schema.NonEmptyString,
        route: Schema.Array(
          Schema.Union(
            Schema.Literal("oral"),
            Schema.Literal("sublingual"),
            Schema.Literal("rectal"),
            Schema.Literal("topical"),
            Schema.Literal("inhalation"),
            Schema.Literal("intravenous"),
            Schema.Literal("intramuscular"),
            Schema.Literal("intradermal"),
            Schema.Literal("subcutaneous"),
            Schema.Literal("nasal"),
            Schema.Literal("ophthalmic"),
            Schema.Literal("otic"),
            Schema.Literal("vaginal"),
            Schema.Literal("transdermal"),
            Schema.Literal("other"),
          ),
        ),
        form: Schema.Array(
          Schema.Union(
            Schema.Literal("tablet"),
            Schema.Literal("syrup"),
            Schema.Literal("ampule"),
            Schema.Literal("suppository"),
            Schema.Literal("cream"),
            Schema.Literal("drops"),
            Schema.Literal("bottle"),
            Schema.Literal("spray"),
            Schema.Literal("gel"),
            Schema.Literal("lotion"),
            Schema.Literal("inhaler"),
            Schema.Literal("capsule"),
            Schema.Literal("injection"),
            Schema.Literal("patch"),
            Schema.Literal("other"),
          ),
        ),
        frequency: Schema.String,
        intervals: Schema.String,
        dose: Schema.String,
        doseUnits: Schema.Array(
          Schema.Union(
            Schema.Literal("mg"),
            Schema.Literal("g"),
            Schema.Literal("mcg"),
            Schema.Literal("mL"),
            Schema.Literal("L"),
            Schema.Literal("units"),
          ),
        ),
        duration: Schema.String,
        durationUnits: Schema.Array(
          Schema.Union(
            Schema.Literal("hours"),
            Schema.Literal("days"),
            Schema.Literal("weeks"),
            Schema.Literal("months"),
            Schema.Literal("years"),
          ),
        ),
      }),
    }),
  ).pipe(Schema.extend(VisibilityRulesSchema));
  export const DiagnosisFieldSchema = createFieldSchema(
    "diagnosis",
    Schema.Struct({
      inputType: Schema.Literal("select"),
      options: Schema.Array(FieldOptionSchema),
    }),
  ).pipe(Schema.extend(VisibilityRulesSchema));
  export const DateFieldSchema = createFieldSchema(
    "date",
    Schema.Struct({
      inputType: Schema.Literal("date"),
    }),
  ).pipe(Schema.extend(InputFieldRulesSchema));
  export const OptionsFieldSchema = createFieldSchema(
    "options",
    Schema.Struct({
      inputType: Schema.Union(
        Schema.Literal("dropdown"),
        Schema.Literal("radio"),
        Schema.Literal("select"),
      ),
      options: Schema.Array(FieldOptionSchema),
      multi: Schema.Boolean,
    }),
  ).pipe(Schema.extend(InputFieldRulesSchema));
  export const FileFieldSchema = createFieldSchema(
    "file",
    Schema.Struct({
      inputType: Schema.Literal("file"),
      allowedMimeTypes: Schema.NullOr(
        Schema.Array(
          Schema.Union(
            Schema.Literal("image/png"),
            Schema.Literal("image/jpeg"),
            Schema.Literal("application/pdf"),
          ),
        ),
      ),
      multiple: Schema.Boolean,
      minItems: Schema.Number,
      maxItems: Schema.Number,
    }),
  ).pipe(Schema.extend(VisibilityRulesSchema));

  export const TextDisplayFieldSchema = createFieldSchema(
    "text",
    Schema.Struct({
      content: Schema.String,
      size: Schema.Union(
        Schema.Literal("xxl"),
        Schema.Literal("xl"),
        Schema.Literal("lg"),
        Schema.Literal("md"),
        Schema.Literal("sm"),
      ),
    }),
  ).pipe(Schema.extend(VisibilityRulesSchema));

  export const SeparatorFieldSchema = createFieldSchema(
    "separator",
    Schema.Struct({}),
  ).pipe(Schema.extend(VisibilityRulesSchema));

  export const FieldSchema = Schema.Union(
    BinaryFieldSchema,
    TextFieldSchema,
    MedicineFieldSchema,
    DiagnosisFieldSchema,
    DateFieldSchema,
    OptionsFieldSchema,
    FileFieldSchema,
    TextDisplayFieldSchema,
    SeparatorFieldSchema,
  );

  export type Field = Schema.Schema.Type<typeof FieldSchema>;

  export type FieldData =
    | BinaryField2
    | TextField2
    | MedicineField2
    | DiagnosisField2
    | DateField2
    | OptionsField2
    | FileField2
    | TextDisplayField2
    | SeparatorField2;

  export function toSchema(field: FieldData): Either.Either<Field, Error> {
    return Schema.encodeUnknownEither(FieldSchema)({ ...field });
  }

  // Flow: Parse with schemas → work with TaggedClass instances → serialize back with schemas.

  const EventFormSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    language: Schema.String,
    is_editable: Schema.Boolean,
    is_snapshot_form: Schema.Boolean,
    form_fields: Schema.Array(FieldSchema),
    metadata: Schema.Record({ key: Schema.String, value: Schema.Any }),
    clinic_ids: Schema.Array(Schema.String),
    translations: Schema.Array(Schema.Any),
    is_deleted: Schema.Boolean,
    created_at: Schema.DateFromSelf,
    updated_at: Schema.DateFromSelf,
    last_modified: Schema.DateFromSelf,
    server_created_at: Schema.DateFromSelf,
    deleted_at: Schema.OptionFromNullOr(Schema.DateFromSelf),
  });
  export type T = typeof EventFormSchema.Type;
  export type EncodedT = typeof EventFormSchema.Encoded;

  // TOMBSTONE 2026-07-26 — see the banner near `BinaryField`. Not to be
  // confused with the live same-named type in `components/types/Inputs`.
  // export type HHFieldWithPosition = HHField & { position: number };

  // FieldLogicPanel adapter.
  //
  // Maps each variant's `fieldType` (+ `inputType` for free-text) to a
  // `LogicFieldKind` / `LogicPrimitiveKind`. Accepts a loose structural
  // shape so callers can hand in either decoded `Field`s or the
  // `FieldData` (TaggedClass) instances the form-builder store carries
  // — both expose the same id/name/fieldType/inputType keys at runtime.
  type LogicAdaptableField = {
    id: string;
    name: string;
    fieldType: string;
    inputType?: string;
    multi?: boolean;
    // Legacy forms store options as bare strings; both shapes reach here.
    options?: (FieldOption | string)[];
  };

  // Option fields expose their choices to the panel's value picker. Event
  // options carry a stable `value`, so rules key on it directly. `multiValue`
  // is set only for multi-select fields, gating the includes/excludes kinds.
  //
  // Legacy forms store options as bare strings (the shape `ensureOptionIds`
  // and the editor's save path both deliberately preserve). Reading `.value`
  // off those yielded `{value: undefined, label: undefined}` entries, which
  // render as blank, unpickable rows in the rule editor's option list — the
  // author sees a select field with choices that can't be chosen. Normalise
  // them to the object shape, and drop anything still lacking a usable
  // token: an option with no value can't appear in a rule, and a Radix
  // `SelectItem` with an empty value throws.
  const optionFields = (
    field: LogicAdaptableField,
  ): Partial<Pick<LogicField, "multiValue" | "options">> => {
    if (field.fieldType !== "options" || !field.options) return {};
    const options = field.options.flatMap(
      (o: FieldOption | string): LogicOption[] => {
        if (typeof o === "string") {
          const value = o.trim();
          return value === "" ? [] : [{ value, label: value }];
        }
        if (typeof o?.value !== "string" || o.value === "") return [];
        return [{ value: o.value, label: o.label ?? o.value }];
      },
    );
    return field.multi === true ? { multiValue: true, options } : { options };
  };

  const fieldTypeToLogicKind = (fieldType: string): LogicFieldKind => {
    switch (fieldType) {
      case "medicine":
      case "diagnosis":
      case "file":
        return "list";
      case "text":
      case "separator":
        return "displayOnly";
      default:
        return "primitive";
    }
  };

  const inferPrimitiveKind = (
    field: LogicAdaptableField,
  ): LogicPrimitiveKind | undefined => {
    if (fieldTypeToLogicKind(field.fieldType) !== "primitive") return undefined;
    switch (field.fieldType) {
      case "date":
        return "date";
      case "free-text":
        return field.inputType === "number" ? "number" : "string";
      case "binary":
      case "options":
      default:
        return "string";
    }
  };

  /**
   * Convert an event form's field list into the abstracted
   * `LogicField[]` consumed by `FieldLogicPanel`. The `displayName`
   * uses the field's `name` (the authoring-time English label).
   */
  export const toLogicFields = (
    fields: ReadonlyArray<LogicAdaptableField>,
  ): LogicField[] =>
    fields.map((f) => ({
      id: f.id,
      displayName: f.name || f.id,
      kind: fieldTypeToLogicKind(f.fieldType),
      primitiveKind: inferPrimitiveKind(f),
      ...(f.fieldType === "free-text" && f.inputType !== "number"
        ? { freeText: true }
        : {}),
      ...optionFields(f),
    }));

  /**
   * Extract the four rule slots from a field in a variant-safe way.
   *
   * `Field` is a discriminated union where `requiredIf` /
   * `validators` / `computedValue` only exist on input-collecting
   * variants (binary / free-text / date / options) — visibility-only
   * variants (medicine / diagnosis / file / text / separator) carry
   * just `visibleIf`. TS can't see all four slots on every branch of
   * the union without a `_tag` narrow at each access site, so the
   * `in`-check pattern here keeps the call sites type-safe without
   * spreading `_tag` switches everywhere.
   */
  export const getRuleSlots = (field: object): FieldRuleSlots => ({
    visibleIf:
      "visibleIf" in field
        ? (field.visibleIf as JsonLogicRule | undefined)
        : undefined,
    requiredIf:
      "requiredIf" in field
        ? (field.requiredIf as JsonLogicRule | undefined)
        : undefined,
    validators:
      "validators" in field
        ? (field.validators as ReadonlyArray<Validator> | undefined)
        : undefined,
    computedValue:
      "computedValue" in field
        ? (field.computedValue as JsonLogicRule | undefined)
        : undefined,
  });

  // TOMBSTONE 2026-07-26 — see the banner near `BinaryField`. Unreferenced:
  // `packages/hh-forms`' `EventForm.getUnitsOpt` is the live replacement, and
  // `components-registry.tsx`'s `hasUnits` is an unrelated local variable.
  // `getUnits` is where the standing `units`-does-not-exist error lived.
  // export namespace Fields {
  //   /**
  //    * Type guard for HHFieldWithPosition | HHField to check if the field has units
  //    * @param field
  //    * @returns
  //    */
  //   export function hasUnits(
  //     field: HHFieldWithPosition | HHField,
  //   ): field is HHFieldWithPosition {
  //     return "units" in field;
  //   }
  //
  //   /**
  //    * Get the units for a field
  //    * @param field
  //    * @returns
  //    */
  //   export function getUnits(
  //     field: HHFieldWithPosition | HHField,
  //   ): (DoseUnit | DurationUnit)[] {
  //     return hasUnits(field) ? Array.from(new Set(field?.units || [])) : [];
  //   }
  // }

  // Two letter iso639-2 language code
  // as seen here: https://www.loc.gov/standards/iso639-2/php/code_list.php
  export type Language =
    | "en"
    | "es"
    | "fr"
    | "de"
    | "it"
    | "pt"
    | "ru"
    | "zh"
    | "ja"
    | "ar"
    | "hi"
    | "bn"
    | "pa"
    | "jv"
    | "ko"
    | "vi"
    | "ta"
    | "ur"
    | "fa"
    | "tr"
    | "pl"
    | "uk"
    | "ro"
    | "nl"
    | "hu"
    | "el"
    | "cs"
    | "sv"
    | "ca"
    | "fi"
    | "he"
    | "no"
    | "id"
    | "ms"
    | "da"
    | "sk"
    | "lt"
    | "hr"
    | "sr"
    | "sl"
    | "et"
    | "lv"
    | "th"
    | "az"
    | "hy"
    | "ka"
    | "eu"
    | "gl"
    | "be"
    | "mk"
    | "bs"
    | "is"
    | "sq"
    | "kk"
    | "ky"
    | "tg"
    | "uz"
    | "tk"
    | "mn"
    | "ja"
    | "ko"
    | "zh"
    | "vi"
    | "th"
    | "lo"
    | "km"
    | "my"
    | "km"
    | "my"
    | "ne"
    | "si"
    | "am"
    | "ti"
    | "so"
    | "sw"
    | "rw"
    | "ny"
    | "mg"
    | "eo"
    | "cy"
    | "gd"
    | "ga"
    | "gd"
    | "ga"
    | "af"
    | "zu"
    | "xh"
    | "st"
    | "tn"
    | "ts"
    | "ss"
    | "ve"
    | "nr"
    | "wo"
    | "fy";

  export type LanguageOption = {
    label: string;
    value: Language;
  };

  // export type HHForm = {
  //   id: string;
  //   name: string;
  //   description: string;
  //   language: Language;
  //   is_editable: boolean;
  //   is_snapshot_form: boolean;
  //   fields: HHField[];
  //   form_fields: HHField[];
  //   createdAt: Date;
  //   updatedAt: Date;
  // };

  export namespace API {
    /**
     * Get a list of all the event forms
     */
    export const getAll = createServerOnlyFn(
      async (options?: { includeDeleted?: boolean }): Promise<EncodedT[]> => {
        const includeDeleted = options?.includeDeleted ?? false;

        let query = db
          .selectFrom(EventForm.Table.name)
          .orderBy("name", "asc")
          .selectAll();

        if (!includeDeleted) {
          query = query.where("is_deleted", "=", false);
        }

        const result = await query.execute();

        return result;
      },
    );

    /**
     * Get a form by an id
     * @param id - The id of the form
     */
    export const getById = createServerOnlyFn(
      async (id: string): Promise<EncodedT> => {
        const result = await db
          .selectFrom(EventForm.Table.name)
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .selectAll()
          .executeTakeFirst();
        return result;
      },
    );

    /**
     * Insert a new event form
     * @param form - The form to insert
     * @returns The inserted form
     */
    export const insert = createServerOnlyFn(
      async (form: EventForm.EncodedT): Promise<EventForm.T> => {
        // Defense-in-depth: structurally validate every rule slot
        // before the JSONB write. The form-builder UI is the primary
        // gate, but this catches direct-API and future-refactor
        // bypasses. Throws FormFieldRulesValidationError on invalid
        // rules; TanStack server functions surface the message to
        // the caller.
        const parsedFields = safeJSONParse(
          form.form_fields,
          [] as Array<unknown>,
        );
        assertFieldRulesValid(
          parsedFields as Array<{ id?: unknown } & Record<string, unknown>>,
        );

        const result = await db
          .insertInto(EventForm.Table.name)
          .values({
            id: uuidV1(),
            name: form.name,
            description: form.description,
            language: form.language,
            is_editable: form.is_editable,
            is_snapshot_form: form.is_snapshot_form,
            form_fields: sql`${JSON.stringify(safeJSONParse(form.form_fields, []))}::jsonb`,
            metadata: sql`${JSON.stringify(safeJSONParse(form.metadata, {}))}::jsonb`,
            clinic_ids: sql`${JSON.stringify(form.clinic_ids ?? [])}::jsonb`,
            translations: sql`${JSON.stringify(form.translations ?? [])}::jsonb`,
            is_deleted: form.is_deleted,
            created_at: sql`now()`,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
            server_created_at: sql`now()`,
            deleted_at: null,
          })
          .returningAll()
          .executeTakeFirst();
        return result;
      },
    );

    /**
     * Update an event form
     * @param id - The id of the form to update
     * @param form - The form to update
     * @returns The updated form
     */
    export const update = createServerOnlyFn(
      async ({
        id,
        form,
      }: {
        id: string;
        form: EventForm.EncodedT;
      }): Promise<EventForm.T> => {
        // Same defense-in-depth as `insert` — see the comment there.
        const parsedFields = safeJSONParse(
          form.form_fields,
          [] as Array<unknown>,
        );
        assertFieldRulesValid(
          parsedFields as Array<{ id?: unknown } & Record<string, unknown>>,
        );

        const result = await db
          .updateTable(EventForm.Table.name)
          .set({
            name: form.name,
            description: form.description,
            language: form.language,
            is_editable: form.is_editable,
            is_snapshot_form: form.is_snapshot_form,
            form_fields: sql`${JSON.stringify(safeJSONParse(form.form_fields, []))}::jsonb`,
            metadata: sql`${JSON.stringify(safeJSONParse(form.metadata, {}))}::jsonb`,
            clinic_ids: sql`${JSON.stringify(form.clinic_ids ?? [])}::jsonb`,
            translations: sql`${JSON.stringify(form.translations ?? [])}::jsonb`,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst();
        return result;
      },
    );

    /**
     * Delete an event form - ALL DELETES ARE JUST SOFT DELETES
     * @param id - The id of the form to delete
     * @returns The deleted form
     */
    export const softDelete = createServerOnlyFn(
      async (id: string): Promise<EventForm.T> => {
        const result = await db
          .updateTable(EventForm.Table.name)
          .set({
            is_deleted: true,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
            deleted_at: sql`now()`,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst();
        return result;
      },
    );

    /**
     * Toggle form snapshot mode
     * @param id - The id of the form to toggle
     * @param isSnapshot - Whether the form should be in snapshot mode
     * @returns The updated form
     */
    export const toggleSnapshot = createServerOnlyFn(
      async ({
        id,
        isSnapshot,
      }: {
        id: string;
        isSnapshot: boolean;
      }): Promise<EventForm.T> => {
        const result = await db
          .updateTable(EventForm.Table.name)
          .set({
            is_snapshot_form: isSnapshot,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst();
        return result;
      },
    );

    /**
     * Toggle form editable mode
     * @param id - The id of the form to toggle
     * @param isEditable - Whether the form should be editable
     * @returns The updated form
     */
    export const toggleEditable = createServerOnlyFn(
      async ({
        id,
        isEditable,
      }: {
        id: string;
        isEditable: boolean;
      }): Promise<EventForm.T> => {
        const result = await db
          .updateTable(EventForm.Table.name)
          .set({
            is_editable: isEditable,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirst();
        return result;
      },
    );
  }
}

export default EventForm;
