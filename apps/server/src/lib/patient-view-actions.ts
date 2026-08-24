/**
 * The action rows a super admin can reorder and show/hide on the mobile
 * PatientViewScreen.
 *
 * The ids here MUST match those in apps/mobile/app/config/patientViewActions.ts.
 * `tests/models/patient-view-actions-parity.test.ts` enforces that.
 */
export const PATIENT_VIEW_ACTIONS_NAMESPACE = "ui";
export const PATIENT_VIEW_ACTIONS_KEY = "patient_view.actions";

export type PatientViewActionEntry = {
  id: string;
  visible: boolean;
};

export const PATIENT_VIEW_ACTIONS = [
  {
    id: "visit_history",
    label: "Visit History",
    description: "All past visits for this patient",
  },
  {
    id: "prescriptions",
    label: "Prescriptions",
    description: "Medications prescribed to this patient",
  },
  {
    id: "vitals",
    label: "Vitals",
    description: "Recorded vital signs over time",
  },
  {
    id: "diagnoses",
    label: "Diagnoses",
    description: "Recorded diagnoses and problems",
  },
] as const;

/** Applied when no configuration row exists. */
export const DEFAULT_PATIENT_VIEW_ACTIONS: PatientViewActionEntry[] =
  PATIENT_VIEW_ACTIONS.map((a) => ({ id: a.id, visible: true }));

/**
 * Mirrors mobile's `isEntry` in app/utils/actionOrder.ts, reimplemented rather
 * than imported across the mobile/server boundary.
 */
const isEntryShape = (
  value: unknown,
): value is { id: string; visible?: unknown } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string";

/**
 * Coerce arbitrary input into the canonical entry list: drop anything that is
 * not `{id: string}`, drop unknown ids, then append the known actions the
 * input left out as `{id, visible: true}`. The result covers every entry in
 * PATIENT_VIEW_ACTIONS exactly once, in the input's order, freshly allocated.
 *
 * Takes `unknown` because both callers pass untrusted input — the loader reads
 * `parseValue`'s `any`, and the save handler's `validator` is a passthrough.
 *
 * The append matters: mobile's resolver appends the missing actions anyway, so
 * without it the admin's saved state and the device's differ invisibly.
 */
export function canonicalizePatientViewActions(
  raw: unknown,
): PatientViewActionEntry[] {
  const known = new Set<string>(PATIENT_VIEW_ACTIONS.map((a) => a.id));
  const seen = new Set<string>();
  const entries: PatientViewActionEntry[] = [];

  for (const candidate of Array.isArray(raw) ? raw : []) {
    if (!isEntryShape(candidate)) continue;
    if (!known.has(candidate.id)) continue;
    // First occurrence wins, matching mobile's resolver. Duplicates would
    // otherwise become duplicate React keys in the sortable list.
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    entries.push({ id: candidate.id, visible: Boolean(candidate.visible) });
  }

  for (const action of PATIENT_VIEW_ACTIONS) {
    if (!seen.has(action.id)) entries.push({ id: action.id, visible: true });
  }
  return entries;
}
