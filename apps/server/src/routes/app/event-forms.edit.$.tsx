import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Option, Schema } from "effect";
import EventForm from "@/models/event-form";
import { useSelector } from "@xstate/store/react";
import eventFormStore from "@/stores/event-form-builder";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import Language from "@/models/language";
import { v1 as uuidV1 } from "uuid";
import { nanoid } from "nanoid";
import {
  LucideBox,
  LucideCalendar,
  LucideList,
  LucideCircle,
  LucideFile,
  LucidePill,
  LucideStethoscope,
  LucideType,
  LucideMinus,
} from "lucide-react";
import {
  deduplicateOptions,
  fieldOptionsUnion,
  findDuplicatesStrings,
  isValidUUID,
  listToFieldOptions,
  safeJSONParse,
} from "@/lib/utils";
import { Result } from "@/lib/result";
import { detectComputedValueCycles } from "@/lib/form-rule-cycles";
import { DatePickerInput } from "@/components/date-picker-input";
import { Separator } from "@/components/ui/separator";
import { InputsConfiguration } from "@/components/form-builder/InputsConfiguration";
import { TranslationBadges } from "@/components/form-builder/TranslationBadges";
import { FormPreviewPane } from "@/components/form-builder/FormPreviewPane";
import { SelectInput } from "@/components/select-input";
import { MultiSelect } from "@/components/multi-select";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Logger } from "@hikmahealth/js-utils";
import { adminMiddleware, superAdminMiddleware } from "@/middleware/auth";

const getFormById = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    const res = await EventForm.API.getById(data.id);

    // For some users migrating from old old version, where the "form_fields" is a JSON string;
    const formFields = (() => {
      let data;
      if (typeof res.form_fields === "string") {
        data = safeJSONParse(res.form_fields, []);
        // Hand the raw string back rather than [] so the client gets one more
        // chance to salvage it.
        if (data.length === 0) {
          data = res.form_fields;
        }
      } else {
        data = res.form_fields;
      }

      // Normalise fields written by older versions.
      if (Array.isArray(data)) {
        data.forEach((field) => {
          // migrate text area to text input with long length
          if (field.inputType === "textarea") {
            field.inputType = "text";
            field.length = "long";
          }
          field._tag = EventForm.getFieldTag(field.fieldType);
        });
      }

      return data;
    })();

    return {
      ...res,
      form_fields: formFields,
      translations: res.translations ?? [],
    };
  });

const saveForm = createServerFn({ method: "POST" })
  .validator(
    (d: { form: EventForm.EncodedT; updateFormId: null | string }) => d,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    const { updateFormId, form } = data;

    if (updateFormId) {
      return EventForm.API.update({
        id: updateFormId,
        form,
      });
    } else {
      return EventForm.API.insert(form);
    }
  });

export const Route = createFileRoute("/app/event-forms/edit/$")({
  // ssr: false,
  component: RouteComponent,
  loader: async ({ params }) => {
    const formId = params._splat;
    const clinics = Result.getOrElse(await getAllClinics(), []);
    if (!formId || formId === "new") {
      return { form: null, clinics };
    }
    return { form: await getFormById({ data: { id: formId } }), clinics };
  },
});

// Exempt from the findDuplicatesStrings check.
const ALLOWED_MULTIPLE_FIELD_ENTRIES = ["separator", "text"];

function RouteComponent() {
  const { form: initialForm, clinics } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const formId = Route.useParams()._splat;
  const isEditing = !!initialForm?.id;

  const [isSubmitting, setIsSubmitting] = useState(false);

  const formState = useSelector(eventFormStore, (state) => state.context);

  useEffect(() => {
    // Lock the document so only the two panels scroll.
    window.scrollTo(0, 0);
    document.body.style.overflow = "hidden";
    return () => {
      window.scrollTo(0, 0);
      document.body.style.overflow = "auto";
    };
  }, []);

  useEffect(() => {
    if (isEditing) {
      eventFormStore.send({ type: "set-form-state", payload: initialForm });
    }
    if (!isEditing || !initialForm || !formId) {
      eventFormStore.send({ type: "reset" });
    }
  }, [initialForm, isEditing, formId]);

  const handleSaveForm = async (event: React.FormEvent) => {
    event.preventDefault();
    const fieldNames = formState.form_fields
      .filter((f) => !ALLOWED_MULTIPLE_FIELD_ENTRIES.includes(f._tag))
      .map((f) => f.name?.trim().toLowerCase());
    const duplicateFieldNames = findDuplicatesStrings(fieldNames);

    if (duplicateFieldNames.length > 0) {
      toast.error(
        `Duplicate field names found: ${duplicateFieldNames.join(", ")}`,
      );
      return;
    }

    const containsReservedFieldNames = formState.form_fields.some((field) =>
      EventForm.RESERVED_FIELD_NAMES.includes(field.name?.trim().toLowerCase()),
    );

    if (containsReservedFieldNames) {
      toast.error("Reserved field names are not allowed");
      return;
    }

    // Mobile suppresses writebacks on a computedValue cycle, but the form
    // still looks broken — catch it here, where the author can fix it.
    const computedCycles = detectComputedValueCycles(
      formState.form_fields.map((f) => ({
        id: f.id,
        computedValue: (f as { computedValue?: unknown }).computedValue,
      })),
    );
    if (computedCycles.length > 0) {
      const fieldNamesById = new Map(
        formState.form_fields.map((f) => [f.id, f.name ?? f.id]),
      );
      const cycleDescriptions = computedCycles
        .map((c) =>
          c.fieldIds.map((id) => fieldNamesById.get(id) ?? id).join(" → "),
        )
        .join("; ");
      toast.error(
        `Cyclic computedValue dependency detected: ${cycleDescriptions}. Remove the cycle before saving.`,
      );
      return;
    }

    // Medicine fields accumulate empty options around the semicolons.
    let cleanedFields = formState.form_fields.map((field) => {
      if (field.options) {
        let cleanedOptions = field.options.map(
          (
            option:
              | { label: string; value: string; __isNew__?: boolean }
              | string,
          ) => {
            if (typeof option === "string") {
              return option?.trim();
            } else if (typeof option === "object") {
              return {
                ...option,
                label: option.label?.trim(),
                value: option.value?.trim(),
                __isNew__: option.__isNew__,
              };
            } else if (
              Array.isArray(option) &&
              option.length > 0 &&
              option[0]?.value
            ) {
              return option.map((subOption) => subOption.value?.trim());
            }
            return option?.trim();
          },
        );
        if (field._tag === "medicine") {
          cleanedOptions = cleanedOptions.filter(
            (value) => value?.trim() !== "",
          );
        }

        return {
          ...field,
          options: cleanedOptions,
        };
      }
      return field;
    });

    // Option ids are the translation keys.
    cleanedFields = EventForm.ensureOptionIds(cleanedFields);

    eventFormStore.send({ type: "set-form-fields", payload: cleanedFields });

    const updateFormId = (() => {
      if (typeof formId === "string" && isValidUUID(formId)) {
        return formId;
      }
      return null;
    })();
    try {
      setIsSubmitting(true);
      await saveForm({
        data: {
          form: { ...formState, form_fields: cleanedFields },
          updateFormId,
        },
      });
      toast.success("Form saved successfully");
      navigate({ to: "/app/event-forms" });
    } catch (error) {
      toast.error("Failed to save form");
      Logger.error(error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const addField = (field: EventForm.FieldData) => {
    eventFormStore.send({ type: "add-field", payload: field });
  };

  const handleFieldRemove = (fieldId: string) => {
    eventFormStore.send({ type: "remove-field", payload: fieldId });
  };

  const handleFieldChange = (fieldId: string, key: string, value: any) => {
    eventFormStore.send({
      type: "set-field-key-value",
      payload: { fieldId, key, value },
    });
  };

  const handleFieldOptionChange = (
    fieldId: string,
    options: EventForm.FieldOption[],
  ) => {
    eventFormStore.send({
      type: "set-dropdown-options",
      payload: { fieldId, value: options },
    });
  };

  const handleFieldUnitChange = (
    fieldId: string,
    units: EventForm.DoseUnit[] | false,
  ) => {
    if (!units) {
      eventFormStore.send({ type: "remove-units", payload: { fieldId } });
      return;
    }
    eventFormStore.send({
      type: "add-units",
      payload: { fieldId, value: units },
    });
  };

  const handleFieldsReorder = (ids: number[]) => {
    eventFormStore.send({ type: "reorder-fields", payload: { indices: ids } });
  };

  return (
    <div className="h-[calc(100vh-100px)] overflow-hidden">
      <div className="grid grid-cols-2 gap-4 h-full">
        {/* Left side - Form configuration */}
        <div
          className=" overflow-y-auto p-4"
          style={{ height: "100%", overflowY: "auto", flex: 1 }}
        >
          <form onSubmit={handleSaveForm} className="h-full space-y-4">
            <Input
              label="Form Title"
              type="text"
              name="name"
              value={formState.name}
              onChange={(e) =>
                eventFormStore.send({
                  type: "set-form-name",
                  payload: e.target.value,
                })
              }
            />
            <TranslationBadges
              primaryLanguage={formState.language}
              translations={
                EventForm.getFieldTranslation(
                  formState.translations,
                  EventForm.FORM_NAME_FIELD_ID,
                )?.name ?? ({} as Language.TranslationObject)
              }
              onTranslationChange={(lang, value) =>
                eventFormStore.send({
                  type: "set-translation",
                  payload: {
                    fieldId: EventForm.FORM_NAME_FIELD_ID,
                    lang,
                    key: "name",
                    value,
                  },
                })
              }
            />
            <SelectInput
              label="Form Language"
              className="w-full"
              value={formState.language}
              onChange={(value) =>
                value &&
                eventFormStore.send({
                  type: "set-form-language",
                  payload: value,
                })
              }
              data={Object.entries(Language.defaultLanguages).map(
                ([key, value]) => ({
                  value: key,
                  label: value,
                }),
              )}
            />
            <Input
              label="Form Description"
              type="textarea"
              name="description"
              value={formState.description}
              onChange={(e) =>
                eventFormStore.send({
                  type: "set-form-description",
                  payload: e.target.value,
                })
              }
            />
            <TranslationBadges
              primaryLanguage={formState.language}
              translations={
                EventForm.getFieldTranslation(
                  formState.translations,
                  EventForm.FORM_DESCRIPTION_FIELD_ID,
                )?.name ?? ({} as Language.TranslationObject)
              }
              onTranslationChange={(lang, value) =>
                eventFormStore.send({
                  type: "set-translation",
                  payload: {
                    fieldId: EventForm.FORM_DESCRIPTION_FIELD_ID,
                    lang,
                    key: "name",
                    value,
                  },
                })
              }
              inputType="textarea"
            />
            <Checkbox
              label="Is Editable"
              name="is_editable"
              checked={formState.is_editable}
              onCheckedChange={(checked) =>
                eventFormStore.send({ type: "toggle-form-editable" })
              }
            />
            {/*<Checkbox
              label="Is Snapshot"
              name="is_snapshot_form"
              checked={formState.is_snapshot_form}
              onCheckedChange={(checked) =>
                eventFormStore.send({ type: "toggle-form-snapshot" })
              }
            />*/}
            {clinics.length > 0 && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Clinics</label>
                <MultiSelect
                  options={clinics.map((c) => ({
                    label: c.name,
                    value: c.id,
                  }))}
                  defaultValue={formState.clinic_ids ?? []}
                  onValueChange={(values) =>
                    eventFormStore.send({
                      type: "set-clinic-ids",
                      payload: values,
                    })
                  }
                  placeholder="All Clinics (no restriction)"
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to make the form available to all clinics.
                </p>
              </div>
            )}
            <Separator className="my-6" />
            <InputsConfiguration
              fields={formState.form_fields}
              onRemoveField={handleFieldRemove}
              onFieldChange={handleFieldChange}
              onFieldOptionChange={handleFieldOptionChange}
              onFieldUnitChange={handleFieldUnitChange}
              onReorder={handleFieldsReorder}
              translations={formState.translations}
              primaryLanguage={formState.language}
              onTranslationChange={(fieldId, lang, key, value) =>
                eventFormStore.send({
                  type: "set-translation",
                  payload: { fieldId, lang, key, value },
                })
              }
              onOptionTranslationChange={(fieldId, optionId, lang, value) =>
                eventFormStore.send({
                  type: "set-option-translation",
                  payload: { fieldId, optionId, lang, value },
                })
              }
              onFieldRulesChange={(fieldId, slots) =>
                eventFormStore.send({
                  type: "set-field-rule-slots",
                  payload: { fieldId, slots },
                })
              }
            />
            <Separator className="my-6" />

            <AddFormInputButtons addField={addField} />
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          </form>
        </div>
        {/* Right side - Live form preview */}
        <FormPreviewPane
          name={formState.name}
          description={formState.description}
          language={formState.language}
          fields={formState.form_fields}
        />
      </div>

      <style>{`
          body {
            overflow-y: hidden;
          }
        `}</style>
    </div>
  );
}

function createComponent(
  field: () => EventForm.FieldData,
  opts: {
    label: string;
    icon?: React.ReactNode;
    // render: React.FC<{ field: FieldDescription }>;
  },
) {
  //   if (!opts.render) {
  //     throw new Error("missing `opts.render` please define or remove component");
  //   }

  return {
    id: String(Math.random() * 10000 + 1), // NOTE: might remove this
    field,
    button: {
      label: opts.label,
      // NOTE: might move this default definition out
      icon: opts.icon ?? <LucideBox />,
    },
    // render: opts.render,
  };
}

const ComponentRegistry = [
  // FIXME: Mobile app is not set up to render checkbox fields, update app to support checkbox fields
  // createComponent(
  //   () =>
  //     new EventForm.BinaryField2({
  //       inputType: "checkbox",
  //       options: [],
  //       id: nanoid(),
  //       name: "",
  //       description: "",
  //       required: false,
  //     }),
  //   {
  //     label: "Checkbox",
  //     icon: <LucideBox />,
  //     //   render: FreeTextInput,
  //   }
  // ),
  createComponent(
    () =>
      new EventForm.TextField2({
        id: nanoid(),
        name: "",
        description: "",
        required: false,
        inputType: "text",
        length: "short",
        units: [],
      }),
    {
      label: "Text",
      icon: <LucideBox />,
      //   render: FreeTextInput,
    },
  ),
  createComponent(
    () =>
      new EventForm.TextField2({
        id: nanoid(),
        name: "",
        description: "",
        required: false,
        inputType: "number",
        length: "short",
        units: [],
      }),
    {
      label: "Number",
      icon: <LucideList />,
      //   render: FreeTextInput,
    },
  ),
  createComponent(
    () =>
      new EventForm.DateField2({
        id: nanoid(),
        name: "",
        description: "",
        required: false,
        inputType: "date",
      }),
    {
      label: "Date",
      icon: <LucideCalendar />,
      //   render: DateInput,
    },
  ),
  createComponent(
    () =>
      new EventForm.OptionsField2({
        id: nanoid(),
        name: "",
        description: "",
        required: false,
        inputType: "select",
        multi: false,
        options: [],
      }),
    {
      label: "Select",
      icon: <LucideList />,
      //   render: SelectInput,
    },
  ),
  createComponent(
    () =>
      new EventForm.OptionsField2({
        id: nanoid(),
        name: "",
        description: "",
        required: false,
        inputType: "radio",
        multi: false,
        options: [],
      }),
    {
      label: "Radio",
      icon: <LucideCircle />,
      //   render: SelectInput,
    },
  ),
  createComponent(
    () =>
      new EventForm.FileField2({
        id: nanoid(),
        name: "",
        description: "",
        required: false,
        inputType: "file",
        allowedMimeTypes: null,
        multiple: false,
        minItems: 0,
        maxItems: 10,
      }),
    {
      label: "File",
      icon: <LucideFile />,
      //   render: FileInput,
    },
  ),
  createComponent(
    () =>
      new EventForm.MedicineField2({
        id: nanoid(),
        name: "Medication",
        description: "",
        required: false,
        inputType: "input-group",
        options: [],
        fields: {
          name: "Name",
          route: EventForm.medicineRoutes as unknown as string[],
          form: EventForm.medicineForms as unknown as string[],
          frequency: "",
          intervals: "",
          dose: "",
          doseUnits: EventForm.doseUnits,
          duration: "",
          durationUnits: EventForm.durationUnits,
        },
      }),
    {
      label: "Medicine",
      icon: <LucidePill />,
      //   render: FreeTextInput,
    },
  ),
  // Diagnoses
  createComponent(
    () =>
      new EventForm.DiagnosisField2({
        id: nanoid(),
        name: "ICD 11 Diagnosis",
        description: "",
        required: false,
        inputType: "select",
        options: [],
        addToProblems: true,
      }),
    {
      label: "Diagnosis",
      icon: <LucideStethoscope />,
      //   render: FreeTextInput,
    },
  ),
  // Text Display Block
  createComponent(
    () =>
      new EventForm.TextDisplayField2({
        id: nanoid(),
        name: "Text Block",
        description: "",
        required: false,
        content: "",
        size: "md",
      }),
    {
      label: "Text Block",
      icon: <LucideType />,
    },
  ),
  // Separator Line
  createComponent(
    () =>
      new EventForm.SeparatorField2({
        id: nanoid(),
        name: "Separator",
        description: "",
        required: false,
      }),
    {
      label: "Separator",
      icon: <LucideMinus />,
    },
  ),
];

/**
 * Bottom row containing the list of components a user can choose from
 */
const AddFormInputButtons = ({
  addField,
}: {
  addField: (field: EventForm.FieldData) => void;
}) => {
  return (
    <div className="flex flex-row flex-wrap gap-2">
      <>
        {ComponentRegistry.map(({ button, field }, ix) => (
          <Button
            size="default"
            key={ix}
            onClick={() => addField(field())}
            type="button"
            // leftIcon={button.icon}
            className="primary"
          >
            {button.label}
          </Button>
        ))}
      </>
    </div>
  );
};
