import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import PatientRegistrationForm from "@/models/patient-registration-form";
import type Patient from "@/models/patient";
import Language from "@/models/language";
import { Label } from "@/components/ui/label";
import { getAllClinics } from "@/lib/server-functions/clinics";
import {
  getPatientById,
  updatePatient,
} from "@/lib/server-functions/patients";
import type { UpdatePatientInput } from "@/lib/server-functions/builders";
import { Result } from "@/lib/result";
import { toast } from "sonner";
import { Logger } from "@hikmahealth/js-utils";
import {
  PatientRegistrationFields,
  buildRegistrationFieldView,
  type RegistrationFieldView,
} from "@/components/form-builder/PatientRegistrationFields";
import {
  compileRules,
  computedCount,
  computedEntries,
  computedValuesEqual,
  formatComputedValue,
  getComputed,
  hasComputed,
  pruneRulesForLiveFields,
  stabilizeComputedValues,
  type fieldWithRules,
  type validationError,
} from "@hikmahealth/forms/Rules";

/**
 * Seed react-hook-form defaults from the patient's current record. Base
 * fields read straight off the patient row; custom fields read from
 * `additional_attributes`, keyed by `field.id` the same way `onSubmit`
 * below writes them back — see `patients.register.tsx` for the write side
 * of this contract.
 */
function buildDefaultFormValues(
  patient: Patient.EncodedT,
  fields: PatientRegistrationForm.Field[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.baseField) {
      const raw = (patient as unknown as Record<string, unknown>)[
        field.column
      ];
      values[field.column] =
        field.fieldType === "date" && raw
          ? new Date(raw as string | Date)
          : (raw ?? undefined);
      continue;
    }

    const attribute = patient.additional_attributes?.[field.id];
    if (!attribute) {
      values[field.column] = undefined;
      continue;
    }

    switch (field.fieldType) {
      case "number":
        values[field.column] = attribute.number_value ?? undefined;
        break;
      case "date":
        values[field.column] = attribute.date_value
          ? new Date(attribute.date_value as unknown as string)
          : undefined;
        break;
      // text / select / checkbox all round-trip through string_value —
      // checkbox stores the joined "a,b" token, same as registration.
      default:
        values[field.column] = attribute.string_value ?? undefined;
    }
  }

  return values;
}

const getAllPatientRegistrationForms = createServerFn({
  method: "GET",
}).handler(async () => {
  return PatientRegistrationForm.getAll();
});

export const Route = createFileRoute("/app/patients/edit/$")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const patientId = params._splat;
    if (!patientId) {
      throw redirect({ to: "/app/patients" });
    }

    const [{ patient }, patientRegistrationForms, clinicsList] =
      await Promise.all([
        getPatientById({ data: { id: patientId } }),
        getAllPatientRegistrationForms(),
        getAllClinics(),
      ]);

    // `redirect()` only short-circuits navigation when thrown from
    // beforeLoad/loader — TanStack Router treats a throw from inside the
    // rendered component as a plain render error, which lands in the
    // route's generic error boundary instead of navigating away. So the
    // not-found/not-authorized check has to live here, not in the
    // component body.
    if (!patient || !patientRegistrationForms[0]) {
      throw redirect({ to: "/app/patients" });
    }

    return {
      patient,
      patientRegistrationForm: patientRegistrationForms[0],
      clinicsList: Result.getOrElse(clinicsList, []),
    };
  },
});

function RouteComponent() {
  const { patient, patientRegistrationForm, clinicsList } =
    Route.useLoaderData();
  const navigate = Route.useNavigate();

  const [lang, setLang] = useState<string>("en");

  const {
    formState,
    handleSubmit,
    register,
    watch,
    setValue,
    getValues,
    control,
  } = useForm({
    mode: "onSubmit",
    defaultValues: buildDefaultFormValues(
      patient,
      patientRegistrationForm.fields,
    ),
  });

  // Rules engine wiring: pre-filter by static admin flags; rule-driven
  // visibility layers on top. Mirrors `patients.register.tsx` exactly so
  // an edited patient sees the same field set / rules a new registration
  // would.
  const fields = useMemo(
    () =>
      (patientRegistrationForm?.fields ?? []).filter(
        (f) => f.visible && f.deleted !== true,
      ),
    [patientRegistrationForm?.fields],
  );

  // RHF keys values by `field.column` (legacy); the engine references
  // fields by `field.id`. Translate at the scope boundary so the engine
  // contract stays uniform with mobile.
  const watchedValues = useWatch({ control }) as
    | Record<string, unknown>
    | undefined;
  const valuesById = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      out[f.id] = watchedValues?.[f.column];
    }
    return out;
  }, [fields, watchedValues]);

  const evaluator = useMemo(() => {
    const ruleFields: fieldWithRules[] = fields.map((f) => ({
      id: f.id,
      required: f.required,
      visibleIf: f.visibleIf,
      requiredIf: f.requiredIf,
      validators: f.validators,
      computedValue: f.computedValue,
    }));
    const liveFieldIds = ruleFields.map((f) => f.id);
    return compileRules(pruneRulesForLiveFields(ruleFields, liveFieldIds));
  }, [fields]);

  const ruleStabilization = useMemo(() => {
    const scope = PatientRegistrationForm.buildRuleScope({
      fields,
      values: valuesById,
      ctx: { now: new Date().toISOString(), language: lang },
    });
    return stabilizeComputedValues(evaluator, scope);
  }, [evaluator, fields, valuesById, lang]);
  const ruleEvaluation = ruleStabilization.evaluation;

  useEffect(() => {
    if (ruleStabilization.convergence === "cycle") {
      Logger.warn({
        msg: "computedValue cycle detected in patient edit form — writebacks suppressed",
      });
    }
  }, [ruleStabilization]);

  const errorsByFieldId = useMemo(() => {
    const m = new Map<string, validationError[]>();
    for (const e of ruleEvaluation.validationErrors) {
      const bucket = m.get(e.fieldId);
      if (bucket) bucket.push(e);
      else m.set(e.fieldId, [e]);
    }
    return m;
  }, [ruleEvaluation]);

  // Clear-on-hide, edit-mode policy. Unlike registration (a blank new
  // patient, nothing to lose), this form loads with a real record that may
  // already sit behind a hidden/conditional field — e.g. a rule was added
  // after the value was saved. Treat whatever's hidden on the *first*
  // evaluation as the baseline instead of "newly hidden", so mounting the
  // page doesn't silently wipe existing data before the user has touched
  // anything. Only hides that happen after that baseline clear their field.
  const hasEstablishedBaselineRef = useRef(false);
  const previouslyHiddenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const { nowHidden, newlyHidden } =
      PatientRegistrationForm.computeNewlyHidden({
        fields,
        evaluation: ruleEvaluation,
        previouslyHidden: previouslyHiddenRef.current,
      });

    if (!hasEstablishedBaselineRef.current) {
      hasEstablishedBaselineRef.current = true;
      previouslyHiddenRef.current = nowHidden;
      return;
    }

    for (const f of newlyHidden) {
      setValue(f.column, undefined as never, {
        shouldValidate: false,
        shouldDirty: false,
      });
    }
    previouslyHiddenRef.current = nowHidden;
  }, [ruleEvaluation, fields, setValue]);

  // Computed-value writeback. Structural equality short-circuit so a
  // rule producing a fresh array/object every eval doesn't loop.
  useEffect(() => {
    if (computedCount(ruleEvaluation) === 0) return;
    for (const [fieldId, computed] of computedEntries(ruleEvaluation)) {
      const field = fields.find((f) => f.id === fieldId);
      if (!field) continue;
      const current = getValues(field.column);
      if (!computedValuesEqual(current, computed)) {
        setValue(field.column, computed as never, { shouldValidate: false });
      }
    }
  }, [ruleEvaluation, fields, setValue, getValues]);

  const onSubmit = async (data: any) => {
    // Rule-driven submit gate — mirrors `patients.register.tsx`.
    const missingRequired = PatientRegistrationForm.getMissingRequiredFields({
      fields,
      values: valuesById,
      evaluation: ruleEvaluation,
    });
    const validatorErrors = ruleEvaluation.validationErrors;
    if (missingRequired.length > 0 || validatorErrors.length > 0) {
      const parts: string[] = [];
      if (missingRequired.length > 0) {
        parts.push(`Missing required: ${missingRequired.join(", ")}`);
      }
      if (validatorErrors.length > 0) {
        const messages = Array.from(
          new Set(validatorErrors.map((e) => e.message)),
        );
        parts.push(messages.join("\n"));
      }
      toast.error(parts.join("\n\n"));
      return;
    }

    const patientFields: UpdatePatientInput["fields"] = {
      given_name: data.given_name ?? null,
      surname: data.surname ?? null,
      date_of_birth:
        data.date_of_birth instanceof Date
          ? data.date_of_birth.toISOString()
          : (data.date_of_birth ?? null),
      sex: data.sex ?? null,
      citizenship: data.citizenship ?? null,
      hometown: data.hometown ?? null,
      phone: data.phone ?? null,
      camp: data.camp ?? null,
      government_id: data.government_id ?? null,
      external_patient_id: data.external_patient_id ?? null,
      photo_url: data.photo_url ?? null,
      primary_clinic_id: data.primary_clinic_id ?? null,
    };

    const additionalAttributes: NonNullable<
      UpdatePatientInput["additionalAttributes"]
    > = [];

    patientRegistrationForm.fields
      .filter((field) => field.deleted !== true && field.visible)
      // Defense-in-depth: skip rule-hidden fields, same reasoning as
      // registration — clear-on-hide should already have wiped their
      // values, this just guards the same-tick submit race.
      .filter((field) => ruleEvaluation.isVisible(field.id))
      .forEach((field) => {
        if (!field.baseField) {
          additionalAttributes.push({
            attribute_id: field.id,
            attribute: field.column,
            number_value:
              field.fieldType === "number" ? Number(data[field.column]) : null,
            string_value: ["text", "select", "checkbox"].includes(
              field.fieldType,
            )
              ? String(data[field.column] ?? "")
              : null,
            date_value:
              field.fieldType === "date" && data[field.column]
                ? data[field.column] instanceof Date
                  ? data[field.column].toISOString()
                  : String(data[field.column])
                : null,
            boolean_value: null,
            metadata: {},
          });
        }
      });

    try {
      const result = await updatePatient({
        data: { id: patient.id, fields: patientFields, additionalAttributes },
      });

      if (!result.success) {
        toast.error(result.error || "Failed to update patient.");
        return;
      }

      toast.success("Patient updated successfully");
      navigate({ to: `/app/patients/${patient.id}` });
    } catch (error) {
      Logger.error({ msg: "Failed to update patient:", error });
      toast.error("Failed to update patient. Please try again.");
    }
  };

  const handleFieldChange = (field: RegistrationFieldView, value: unknown) => {
    setValue(field.column, value as never, { shouldValidate: true });
  };

  const visibleFields = (patientRegistrationForm.fields ?? [])
    .filter((field) => field.visible && field.deleted !== true)
    .filter((field) => ruleEvaluation.isVisible(field.id));

  const fieldViews: RegistrationFieldView[] = visibleFields.map(
    (field, idx) => {
      const isComputed = hasComputed(ruleEvaluation, field.id);
      const rhfError = formState.errors[field.column]?.message;
      return buildRegistrationFieldView(field, idx, lang, {
        value: watch(field.column),
        required: ruleEvaluation.isRequired(field.id),
        computedDisplay: isComputed
          ? formatComputedValue(getComputed(ruleEvaluation, field.id))
          : null,
        errorMessage: typeof rhfError === "string" ? rhfError : null,
        validatorErrors: Array.from(
          new Set((errorsByFieldId.get(field.id) ?? []).map((e) => e.message)),
        ),
        clinicOptions: clinicsList.map((clinic) => ({
          value: clinic.id,
          label: clinic.name,
        })),
      });
    },
  );

  return (
    <div className="pb-4">
      <div className="container mx-auto px-6 pt-6">
        <h1 className="text-2xl font-bold">
          Edit {patient.given_name || "—"} {patient.surname || "—"}
        </h1>
      </div>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ maxWidth: 500 }} className="container mx-auto p-6 space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Language</Label>
            <Select value={lang} onValueChange={setLang}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Language.supportedLanguages.map((code) => (
                  <SelectItem key={code} value={code}>
                    {Language.friendlyLang(code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <PatientRegistrationFields
            fields={fieldViews}
            onValueChange={handleFieldChange}
          />

          {/* Hidden RHF-registered inputs hold required-validation and
              submit wiring inside the form, so the renderer above stays
              free of react-hook-form. Computed fields are excluded — they
              are read-only and their values arrive via writeback. */}
          {visibleFields
            .filter((field) => !hasComputed(ruleEvaluation, field.id))
            .map((field) => {
              const required = ruleEvaluation.isRequired(field.id);
              const fieldLabel = Language.getTranslation(field.label, lang);
              return (
                <input
                  key={field.id}
                  type="hidden"
                  {...register(field.column, {
                    required: required && `${fieldLabel} is required`,
                  })}
                />
              );
            })}

          <div className="flex justify-end gap-4">
            <Button type="button" variant="outline" asChild>
              <Link to={`/app/patients/${patient.id}`}>Cancel</Link>
            </Button>
            <Button type="submit" data-testid={"submit-button"}>
              {formState.isSubmitting ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
