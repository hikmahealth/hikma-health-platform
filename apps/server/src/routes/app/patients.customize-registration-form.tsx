import { createFileRoute } from "@tanstack/react-router";
import { Language } from "@/models/language";
import sortBy from "lodash/sortBy";
import { useEffect, useMemo, useState } from "react";
import { useImmer, useImmerReducer } from "use-immer";

import PatientRegistrationForm from "@/models/patient-registration-form";
import type { FieldRuleSlots } from "@/models/form-rules";
import { detectComputedValueCycles } from "@/lib/form-rule-cycles";
import { FieldLogicPanel } from "@/components/form-builder/FieldLogicPanel";
import { RegistrationFormPreviewPane } from "@/components/form-builder/RegistrationFormPreviewPane";
import { v1 as uuidv1 } from "uuid";
import { baseFields } from "@/data/registration-form-base-fields";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import React from "react";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getPatientRegistrationForm } from "@/lib/server-functions/patient-registration-forms";
import { Logger } from "@hikmahealth/js-utils";
import {
  LucideChevronDown,
  LucideGripHorizontal,
  LucideRefreshCcwDot,
  LucideSlidersHorizontal,
  LucideTrash2,
} from "lucide-react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { superAdminMiddleware } from "@/middleware/auth";

const saveForm = createServerFn({ method: "POST" })
  .validator((data: PatientRegistrationForm.EncodedT) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return await PatientRegistrationForm.upsertPatientRegistrationForm(data);
  });

export const Route = createFileRoute(
  "/app/patients/customize-registration-form",
)({
  component: RouteComponent,
  loader: async () => {
    const form = await getPatientRegistrationForm();
    return {
      patientRegistrationForm: form,
    };
  },
});

const registrationFormFieldSchema = z.object({
  id: z.string().min(1),
  position: z.number().min(1),
  column: z.string().min(1),
  label: z.record(z.string(), z.string().min(0)),
  fieldType: z.enum(PatientRegistrationForm.inputTypes),
  options: z.array(z.record(z.string(), z.string().min(1))),
  required: z.boolean(),
  baseField: z.boolean(),
  visible: z.boolean(),
  unique: z.boolean(),
  deleted: z.boolean(),
  showsInSummary: z.boolean(),
  isSearchField: z.boolean(),
});

const registrationFormSchema = z.object({
  id: z.string().min(10),
  clinic_id: z.string().nullable(),
  name: z.string(),
  fields: z.array(registrationFormFieldSchema),
  metadata: z.record(z.string(), z.any()),
  is_deleted: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
  last_modified: z.date(),
  server_created_at: z.date(),
  deleted_at: z.date().nullable(),
});

type State = PatientRegistrationForm.EncodedT;
type Action =
  | { type: "set-form-state"; payload: { form: State } } // sets the entire form to a specific value. usefull for initial states and setting values to what is in the database.
  | { type: "add-field" } // generates a fieldID by default
  | { type: "remove-field"; payload: { id: string } } // only removes fields that are not base fields
  | { type: "restore-field"; payload: { id: string } } // restores previously deleted fields
  | { type: "change-position"; payload: { id: string; position: number } }
  | {
      type: "update-field-label";
      payload: { translation: string; label: string; id: string };
    }
  | { type: "toggle-field-required"; payload: { id: string } }
  | { type: "toggle-field-unique"; payload: { id: string } }
  | { type: "toggle-field-searchable"; payload: { id: string } }
  | { type: "toggle-field-shows-in-summary"; payload: { id: string } }
  | {
      type: "toggle-visibility";
      payload: {
        id: string;
      };
    }
  | {
      type: "update-field-translation";
      payload: {
        language: string;
        text: string;
      };
    }
  | {
      type: "update-field-type";
      payload: {
        id: string;
        type: PatientRegistrationForm.InputType;
      };
    }
  | {
      type: "add-select-option";
      payload: { id: string };
    }
  | {
      type: "remove-select-option";
      payload: { id: string; index: number };
    }
  | {
      type: "add-select-option-translation";
      payload: {
        id: string;
        index: number;
        language: Language.LanguageKey;
      };
    }
  | {
      type: "remove-select-option-translation";
      payload: {
        id: string;
        index: number;
        language: Language.LanguageKey;
      };
    }
  | {
      type: "update-select-option-translation";
      payload: {
        id: string;
        index: number;
        language: Language.LanguageKey;
        value: string;
      };
    }
  | {
      type: "set-field-rule-slots";
      payload: { id: string; slots: FieldRuleSlots };
    };

function reducer(state: State, action: Action) {
  switch (action.type) {
    case "set-form-state": {
      const { form } = action.payload;
      // Immer drafts don't trigger a reload on whole-object assignment; set each field.
      state.name = form.name;
      state.created_at = form.created_at;
      state.id = form.id;
      state.updated_at = form.updated_at;
      state.metadata = form.metadata;

      state.fields = [...form.fields];
      break;
    }
    case "add-field": {
      const position = state.fields.length + 1;
      const newField: PatientRegistrationForm.Field = {
        id: uuidv1(),
        baseField: false,
        fieldType: "text",
        isSearchField: false,
        column: encodeURI("New Field " + position),
        label: {
          en: "New Field " + position,
          es: "Nueva Entrada " + position,
          ar: "مدخلات جديدة",
        },
        options: [],
        position: position,
        required: true,
        visible: true,
        unique: false,
        deleted: false,
        showsInSummary: false,
      };

      state.fields.push(newField);
      break;
    }
    case "update-field-label": {
      const { label, id, translation } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (field) {
        field.label[translation] = label;

        // edit the column name to be the english translation of a field && is not a base field
        // IMPORTANT: never edit a base field. these fields map to the column names in the mobile application
        if (translation === "en" && field.baseField === false) {
          if (field.label["en"].length > 0) {
            field.column = encodeURI(field.label["en"]);
          }
        }

        // FIXME: Should you be able to update the column name for even base fields?? Probably not!
        // FIXME: Are the column names even needed for the additional fields???
        // field.column = getTranslation(field.label, translation)
      }
      break;
    }
    case "update-field-type": {
      const { id, type } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (field) {
        const oldFieldType = field.fieldType;
        field.fieldType = type;

        const typesWithOptions = ["select", "checkbox"];
        const hadOptions = typesWithOptions.includes(oldFieldType);
        const needsOptions = typesWithOptions.includes(type);

        if (!hadOptions && needsOptions) {
          field.options.length === 0 &&
            field.options.push({
              en: "",
            });
        } else if (hadOptions && !needsOptions) {
          field.options = [];
        }

        // Uniqueness is only offered for scalar text/number fields (see
        // FieldFlagsEditor). Clear a stale unique flag when the field is
        // switched to a non-eligible type so it can't persist unseen.
        const uniqueEligibleTypes = ["text", "number"];
        if (!uniqueEligibleTypes.includes(type)) {
          field.unique = false;
        }
      }
      break;
    }
    case "add-select-option": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (
        field &&
        (field.fieldType === "select" || field.fieldType === "checkbox")
      ) {
        field.options.push({ en: "" });
      }
      break;
    }
    case "remove-select-option": {
      const { id, index } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (
        field &&
        (field.fieldType === "select" || field.fieldType === "checkbox")
      ) {
        field.options.splice(index, 1);
      }
      break;
    }
    case "add-select-option-translation": {
      const { id, index, language } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (
        field &&
        (field.fieldType === "select" || field.fieldType === "checkbox")
      ) {
        field.options.forEach((field, idx) => {
          if (idx === index) {
            field[language] = "";
          }
        });
      }
      break;
    }
    case "remove-select-option-translation": {
      const { id, index, language } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (
        field &&
        (field.fieldType === "select" || field.fieldType === "checkbox")
      ) {
        field.options.forEach((field, idx) => {
          if (idx === index) {
            delete field[language];
          }
        });
      }
      break;
    }
    case "update-select-option-translation": {
      const { id, index, language, value } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (
        field &&
        (field.fieldType === "select" || field.fieldType === "checkbox")
      ) {
        field.options.forEach((field, idx) => {
          if (idx === index) {
            field[language] = value;
          }
        });
      }
      break;
    }
    case "remove-field": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);
      if (field === undefined) return;

      // state.fields = state.fields.filter((field) => field.id !== id);
      // Soft delete: the field stays in the array so its position is preserved.
      state.fields = state.fields.map((field) => {
        if (field.id === id) {
          return { ...field, deleted: true };
        } else {
          return field;
        }
      });

      break;
    }
    case "restore-field": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);
      if (field === undefined) return;

      state.fields = state.fields.map((field) => {
        if (field.id === id) {
          return { ...field, deleted: false };
        } else {
          return field;
        }
      });

      break;
    }
    case "change-position": {
      const { id, position } = action.payload;

      if (position <= 0) return;
      if (position > state.fields.length) return;

      const field = state.fields.find((f) => f.id === id);

      if (field) {
        const sorted = sortBy(state.fields, ["position"]);

        const remainingSorted = sorted.filter((f) => f.id !== id);

        remainingSorted.splice(position - 1, 0, field);
        state.fields = remainingSorted.map((field, idx) => ({
          ...field,
          position: idx + 1,
        }));
      }

      break;
    }
    case "toggle-visibility": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (field) {
        field.visible = !field.visible;
      }
      break;
    }
    case "toggle-field-required": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);
      // We used to enforce that baseFields are all required , since they are part of the actual columns and tables.
      // This feature disabled June 4th 2026
      // TOMBSTONE: June 4th 2026
      // if (field?.baseField) return;

      if (field) {
        field.required = !field.required;
      }
      break;
    }
    case "toggle-field-unique": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);

      if (field) {
        field.unique = !field.unique;
      }
      break;
    }
    case "toggle-field-searchable": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);
      if (!field) return;

      field.isSearchField = !field.isSearchField;
      break;
    }
    case "toggle-field-shows-in-summary": {
      const { id } = action.payload;
      const field = state.fields.find((f) => f.id === id);
      if (!field) return;

      field.showsInSummary = !field.showsInSummary;
      break;
    }
    case "set-field-rule-slots": {
      const { id, slots } = action.payload;
      const field = state.fields.find((f) => f.id === id);
      if (!field) return;
      // Atomic write of all four slots; an undefined entry clears its slot.
      field.visibleIf = slots.visibleIf;
      field.requiredIf = slots.requiredIf;
      field.validators = slots.validators;
      field.computedValue = slots.computedValue;
      break;
    }
  }
}

const defaultEmptyForm: PatientRegistrationForm.EncodedT = {
  id: uuidv1(),
  // Remove when the migrating to multiple forms support
  name: "Patient Registration Form",
  fields: baseFields,
  metadata: {},
  created_at: new Date(),
  updated_at: new Date(),
  clinic_id: null,
  is_deleted: false,
  last_modified: new Date(),
  server_created_at: new Date(),
  deleted_at: null,
};

function RouteComponent() {
  const { patientRegistrationForm } = Route.useLoaderData();
  const loadedForm =
    (patientRegistrationForm as PatientRegistrationForm.EncodedT) ??
    defaultEmptyForm;
  // Legacy stored forms predate the `unique` flag. Default it so fields
  // validate against the (required) field schema when the form is re-saved.
  const initialState: PatientRegistrationForm.EncodedT = {
    ...loadedForm,
    fields: loadedForm.fields.map((f) => ({ unique: false, ...f })),
  };

  const [formLanguage, setFormLanguage] = useState<Language.LanguageKey>("en");
  const [state, dispatch] = useImmerReducer(reducer, initialState);
  const { fields } = state;
  const [loading, setLoading] = useState(false);
  const deletedFields = useMemo(
    () => fields.filter((f) => f.deleted),
    [fields, fields.length],
  );

  const visibleFields = sortBy(fields, "position").filter((f) => !f.deleted);

  const [expandedFields, setExpandedFields] = useState<string[]>([]);
  const toggleExpandedField = (fieldId: string) => {
    setExpandedFields((fields) => {
      const index = fields.indexOf(fieldId);
      if (index > -1) {
        return fields.filter((f) => f !== fieldId);
      } else {
        return [...fields, fieldId];
      }
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Positions are full-array (incl. deleted) coordinates, so use the over
  // field's stored position, not its index in the filtered render list.
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const overField = state.fields.find((f) => f.id === over.id);
    if (overField === undefined) return;

    dispatch({
      type: "change-position",
      payload: { id: String(active.id), position: overField.position },
    });
  };

  useEffect(() => {
    // Lock the document so only the two panes scroll.
    window.scrollTo(0, 0);
    document.body.style.overflow = "hidden";
    return () => {
      window.scrollTo(0, 0);
      document.body.style.overflow = "auto";
    };
  }, []);

  const submit = async () => {
    if (loading) return;
    const result = registrationFormSchema.safeParse(state);

    let ignoreErrors = false;

    if (!result.success) {
      Logger.error(result.error);
      if (result.error.issues.find((err) => err.path.includes("options"))) {
        return alert(
          "Please make sure all select fields have at least one option",
        );
      } else {
        ignoreErrors = window.confirm(
          "Some fields of the form are incomplete or empty. Are you sure you want to continue?",
        );
      }
    }

    // Mobile suppresses writebacks on a computedValue cycle, but the form
    // still looks broken — catch it here, where the author can fix it.
    const computedCycles = detectComputedValueCycles(
      state.fields.map((f) => ({
        id: f.id,
        computedValue: (f as { computedValue?: unknown }).computedValue,
      })),
    );
    if (computedCycles.length > 0) {
      const labelById = new Map(
        state.fields.map((f) => [
          f.id,
          Language.getTranslation(f.label, "en") || f.column || f.id,
        ]),
      );
      const cycleDescriptions = computedCycles
        .map((c) => c.fieldIds.map((id) => labelById.get(id) ?? id).join(" → "))
        .join("; ");
      alert(
        `Cyclic computedValue dependency detected: ${cycleDescriptions}.\nRemove the cycle before saving.`,
      );
      return;
    }

    if ((!result.success && ignoreErrors === true) || result.success === true) {
      setLoading(true);

      try {
        const res = await saveForm({ data: state });
        alert("Form saved successfully!");
      } catch (error) {
        Logger.error({ msg: "Failed to save form:", error });
        alert("Failed to save the form. Please try again later.");
      } finally {
        setLoading(false);
      }

      return;
    }
  };

  const confirmRemoveField = (field: PatientRegistrationForm.Field) => {
    if (
      !window.confirm(
        `Are you sure you want to remove ${field.label.en}. This does not affect data already collected and can be undone in the future.`,
      )
    ) {
      return;
    }
    dispatch({
      type: "remove-field",
      payload: { id: field.id },
    });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-screen overflow-hidden">
      <div className="mb-14 overflow-y-auto p-4">
        <div className="pb-4">
          <h1 className="text-xl font-semibold">{state.name}</h1>
        </div>
        <Select value={formLanguage} onValueChange={setFormLanguage}>
          <SelectTrigger className="w-45">
            <SelectValue placeholder="Select a language" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Languages</SelectLabel>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ar">Arabic</SelectItem>
              <SelectItem value="es">Spanish</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>

        <div className="max-w-lg pt-6">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <div className="space-y-4">
              <SortableContext
                items={visibleFields.map((f) => f.id)}
                strategy={verticalListSortingStrategy}
              >
                {visibleFields.map((field) => {
                  const { id } = field;
                  const isOpen = expandedFields.includes(id);

                  return (
                    <SortableItem id={id} key={field.id}>
                      <div className="p-4 bg-muted/50 rounded-lg border">
                        <Collapsible
                          open={isOpen}
                          onOpenChange={() => toggleExpandedField(id)}
                          className=""
                          data-testid="registration-form-customizer-field"
                        >
                          <CollapsibleTrigger asChild>
                            <div className="flex gap-2 py-1 font-semibold w-full items-center justify-between rounded-md">
                              <h3 className="text-lg">
                                {Language.getTranslation(
                                  field.label,
                                  formLanguage,
                                )}
                              </h3>
                              <LucideChevronDown
                                size="1rem"
                                className={`transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`}
                              />
                            </div>
                          </CollapsibleTrigger>

                          <CollapsibleContent>
                            <FieldEditPanel
                              field={field}
                              formFields={state.fields}
                              dispatch={dispatch}
                            />

                            <div className="pt-4">
                              <Button
                                variant="outline"
                                className="text-destructive hover:bg-destructive/80 hover:text-white gap-2"
                                onClick={() => confirmRemoveField(field)}
                                size="sm"
                              >
                                <LucideTrash2 />
                                Delete Field
                              </Button>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    </SortableItem>
                  );
                })}
              </SortableContext>
            </div>
          </DndContext>
        </div>

        {/** Deleted fields show here */}
        <DeletedFieldsList
          fields={deletedFields}
          language={formLanguage}
          dispatch={dispatch}
        />

        <div className=" max-w-lg">
          <div className="flex flex-col gap-4 mt-4">
            <Button
              onClick={() => dispatch({ type: "add-field" })}
              variant="outline"
              className="w-full"
            >
              + Add Field
            </Button>

            <Button
              disabled={loading}
              className="w-full primary"
              onClick={submit}
            >
              {loading ? "Loading ..." : "Submit"}
            </Button>
          </div>
        </div>
      </div>
      <RegistrationFormPreviewPane
        fields={state.fields}
        language={formLanguage}
      />
    </div>
  );
}

type FormDispatch = (action: Action) => void;

const CircleMinusIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="lucide lucide-circle-minus"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M8 12h8" />
  </svg>
);

/**
 * Sortable wrapper for a field card. The drag listeners live only on the
 * grip handle, so the card's own Collapsible trigger and inputs stay
 * clickable; the whole item (handle + card) translates while dragging.
 */
function SortableItem({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div
        {...listeners}
        className="flex items-center content-center justify-center cursor-move -mb-2"
      >
        <LucideGripHorizontal
          className="text-muted-foreground self-center"
          color="var(--foreground)"
          size="1rem"
        />
      </div>
      {children}
    </div>
  );
}

/** Per-language option editor for select/checkbox fields. */
function OptionsEditor({
  field,
  dispatch,
}: {
  field: PatientRegistrationForm.Field;
  dispatch: FormDispatch;
}) {
  const { id } = field;
  const friendlyLang = Language.friendlyLang;

  return (
    <div className="col-span-12">
      <div className="space-y-4">
        <label className="text-sm font-medium leading-none">Options</label>
        {field.options.map((option, idx) => {
          return (
            <div key={idx}>
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-11">
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none">{`Option ${
                      idx + 1
                    } (English)`}</label>
                    <input
                      type="text"
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      value={option.en}
                      onChange={({ target: { value } }) =>
                        dispatch({
                          type: "update-select-option-translation",
                          payload: { id, index: idx, language: "en", value },
                        })
                      }
                    />
                  </div>
                </div>
                <div className="col-span-1 flex items-end justify-center">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      dispatch({
                        type: "remove-select-option",
                        payload: { id, index: idx },
                      })
                    }
                    className="text-destructive hover:text-destructive"
                  >
                    <CircleMinusIcon />
                  </Button>
                </div>
              </div>

              <div className="flex gap-2 mt-2">
                {!("es" in option) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      dispatch({
                        type: "add-select-option-translation",
                        payload: { id, index: idx, language: "es" },
                      })
                    }
                  >
                    + Spanish
                  </Button>
                )}
                {!("ar" in option) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      dispatch({
                        type: "add-select-option-translation",
                        payload: { id, index: idx, language: "ar" },
                      })
                    }
                  >
                    + Arabic
                  </Button>
                )}
              </div>

              <div className="pl-8 space-y-2 pb-5">
                {Object.keys(option)
                  .filter((k) => k !== "en")
                  .map((languageKey) => (
                    <div className="grid grid-cols-12 gap-2" key={languageKey}>
                      <div className="col-span-10">
                        <div className="space-y-2">
                          <label className="text-sm font-medium leading-none">{`Option ${
                            idx + 1
                          } (${friendlyLang(languageKey)})`}</label>
                          <input
                            type="text"
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            value={option[languageKey]}
                            onChange={({ target: { value } }) =>
                              dispatch({
                                type: "update-select-option-translation",
                                payload: {
                                  id,
                                  index: idx,
                                  language: languageKey,
                                  value,
                                },
                              })
                            }
                          />
                        </div>
                      </div>
                      <div className="col-span-2 flex items-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            dispatch({
                              type: "remove-select-option-translation",
                              payload: {
                                id,
                                index: idx,
                                language: languageKey,
                              },
                            })
                          }
                          className="text-destructive hover:text-destructive"
                        >
                          <CircleMinusIcon />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          );
        })}
        <Button
          variant="outline"
          className="w-full mt-2"
          onClick={() =>
            dispatch({ type: "add-select-option", payload: { id } })
          }
        >
          Add Select Option
        </Button>
      </div>
    </div>
  );
}

function CheckboxRow({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center space-x-2">
      <input
        type="checkbox"
        id={id}
        className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
        checked={checked}
        onChange={onChange}
      />
      <label
        htmlFor={id}
        className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
      >
        {label}
      </label>
    </div>
  );
}

/** The visibility / required / searchable / summary toggles for a field. */
function FieldFlagsEditor({
  field,
  dispatch,
}: {
  field: PatientRegistrationForm.Field;
  dispatch: FormDispatch;
}) {
  const {
    id,
    visible,
    required,
    unique,
    isSearchField,
    showsInSummary,
    fieldType,
  } = field;

  // Scalar text/number only: a unique boolean caps the table at two patients,
  // select/checkbox values are multi-value, and dates round-trip through
  // representations that make exact equality unreliable.
  const uniqueEligible = fieldType === "text" || fieldType === "number";

  return (
    <div className="col-span-12 space-y-3">
      <CheckboxRow
        id={`visible-${id}`}
        checked={visible}
        onChange={() =>
          dispatch({ type: "toggle-visibility", payload: { id } })
        }
        label="This field is visible to clinicians"
      />
      <CheckboxRow
        id={`required-${id}`}
        checked={required}
        onChange={() =>
          dispatch({ type: "toggle-field-required", payload: { id } })
        }
        label="This field is required"
      />
      {uniqueEligible && (
        <CheckboxRow
          id={`unique-${id}`}
          checked={unique}
          onChange={() =>
            dispatch({ type: "toggle-field-unique", payload: { id } })
          }
          label="This field is unique - do not allow duplicates across patients"
        />
      )}
      <CheckboxRow
        id={`searchable-${id}`}
        checked={isSearchField}
        onChange={() =>
          dispatch({ type: "toggle-field-searchable", payload: { id } })
        }
        label="This field is included in advanced search"
      />
      <CheckboxRow
        id={`summary-${id}`}
        checked={showsInSummary}
        onChange={() =>
          dispatch({ type: "toggle-field-shows-in-summary", payload: { id } })
        }
        label="This field is visible in the patient file summary"
      />
    </div>
  );
}

/** Full edit form for a single field, shown when a field is in edit mode. */
function FieldEditPanel({
  field,
  formFields,
  dispatch,
}: {
  field: PatientRegistrationForm.Field;
  formFields: PatientRegistrationForm.Field[];
  dispatch: FormDispatch;
}) {
  const { id, label, fieldType, position } = field;
  const getTranslation = Language.getTranslation;
  const inputTypes = PatientRegistrationForm.inputTypes;

  return (
    <div className="">
      <div className="grid grid-cols-12 gap-3">
        {Language.supportedLanguages.map((languageKey) => {
          return (
            <React.Fragment key={languageKey}>
              {/*<div className="col-span-4">*/}
              {/*<p>{Language.friendlyLang(languageKey)}</p>*/}
              {/*<div className="space-y-2">
                  <label className="text-sm font-medium leading-none">
                    Language
                  </label>
                  <Select value={languageKey || "en"}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en">English</SelectItem>
                      <SelectItem value="es">Spanish</SelectItem>
                      <SelectItem value="ar">Arabic</SelectItem>
                    </SelectContent>
                  </Select>
                </div>*/}
              {/*</div>*/}
              <div className="col-span-full">
                <div className="space-y-1">
                  <label className="text-sm font-medium leading-none">
                    {Language.friendlyLang(languageKey)} Field Name
                  </label>
                  <input
                    type="text"
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    value={getTranslation(label, languageKey)}
                    onChange={(e) => {
                      dispatch({
                        type: "update-field-label",
                        payload: {
                          id: id,
                          label: e.target.value,
                          translation: languageKey,
                        },
                      });
                    }}
                  />
                </div>
              </div>
            </React.Fragment>
          );
        })}

        <div className="col-span-12 w-full">
          <div className="space-y-2 w-full">
            <label className="text-sm font-medium leading-none">
              Field Type
            </label>
            <Select
              value={fieldType || "text"}
              onValueChange={(value) =>
                dispatch({
                  type: "update-field-type",
                  payload: {
                    id,
                    type: value as PatientRegistrationForm.InputType,
                  },
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {inputTypes.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {(fieldType === "select" || fieldType === "checkbox") && (
          <OptionsEditor field={field} dispatch={dispatch} />
        )}

        <FieldFlagsEditor field={field} dispatch={dispatch} />

        <div className="col-span-12">
          <FieldLogicPanel
            form={PatientRegistrationForm.toLogicFields(formFields)}
            fieldId={id}
            initial={{
              visibleIf: field.visibleIf,
              requiredIf: field.requiredIf,
              validators: field.validators,
              computedValue: field.computedValue,
            }}
            onSave={(slots) =>
              dispatch({
                type: "set-field-rule-slots",
                payload: { id, slots },
              })
            }
          />
        </div>
      </div>
    </div>
  );
}

/** List of soft-deleted fields with a restore action. */
function DeletedFieldsList({
  fields,
  language,
  dispatch,
}: {
  fields: PatientRegistrationForm.Field[];
  language: Language.LanguageKey;
  dispatch: FormDispatch;
}) {
  const [isOpen, setIsOpen] = useState(false);
  if (fields.length === 0) return null;

  return (
    <div className="py-4">
      <hr />
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className="pt-2"
        data-testid="field-logic-panel"
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="field-logic-toggle"
            className="flex w-full items-center justify-between rounded-md hover:bg-muted/40"
          >
            <div className="text-lg font-semibold">Deleted fields</div>
            <LucideChevronDown
              size="1rem"
              className={`transition-transform ${isOpen ? "rotate-0" : "-rotate-90"} align-cen`}
            />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          {fields.map((field) => {
            return (
              <div
                className="flex items-center justify-between gap-2"
                key={field.id}
              >
                <div>
                  <label>
                    {Language.getTranslation(field.label, language)}
                  </label>
                </div>

                <Button
                  variant="link"
                  aria-label="Settings"
                  className="gap-1 text-green-700 cursor-pointer"
                  onClick={() =>
                    dispatch({
                      type: "restore-field",
                      payload: { id: field.id },
                    })
                  }
                >
                  <LucideRefreshCcwDot />
                  Restore
                </Button>
              </div>
            );
          })}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function translationObjectOptions(
  translations: Language.TranslationObject[],
  language: Language.LanguageKey,
): Array<{ label: string; value: string }> {
  return translations
    .map((t) => Language.getTranslation(t, language))
    .map((st) => ({
      label: st,
      value: st,
    }));
}
