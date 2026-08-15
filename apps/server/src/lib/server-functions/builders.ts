/**
 * Pure builder functions for transforming RPC input into DB insert/update value objects.
 * These contain no DB access, no auth, no side effects — making them ideal test targets.
 */

import { uuidv7 } from "uuidv7";

// ──────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────

export type Pagination = {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

// ──────────────────────────────────────────────
// Patient types & builders
// ──────────────────────────────────────────────

export type CreatePatientInput = {
  patient: {
    given_name?: string | null;
    surname?: string | null;
    date_of_birth?: string | null;
    sex?: string | null;
    citizenship?: string | null;
    hometown?: string | null;
    phone?: string | null;
    camp?: string | null;
    government_id?: string | null;
    external_patient_id?: string | null;
    additional_data?: Record<string, any>;
    metadata?: Record<string, any>;
    photo_url?: string | null;
    primary_clinic_id?: string | null;
  };
  additionalAttributes?: Array<{
    attribute_id: string;
    attribute: string;
    number_value?: number | null;
    string_value?: string | null;
    date_value?: string | null;
    boolean_value?: boolean | null;
    metadata?: Record<string, any>;
  }>;
};

export type UpdatePatientInput = {
  id: string;
  fields: Partial<{
    given_name: string | null;
    surname: string | null;
    date_of_birth: string | null;
    sex: string | null;
    citizenship: string | null;
    hometown: string | null;
    phone: string | null;
    camp: string | null;
    government_id: string | null;
    external_patient_id: string | null;
    additional_data: Record<string, any>;
    metadata: Record<string, any>;
    photo_url: string | null;
    primary_clinic_id: string | null;
  }>;
  // Custom registration-form fields (non-baseField). Upserted by
  // `attribute_id`, same shape as `CreatePatientInput.additionalAttributes`.
  additionalAttributes?: Array<{
    attribute_id: string;
    attribute: string;
    number_value?: number | null;
    string_value?: string | null;
    date_value?: string | null;
    boolean_value?: boolean | null;
    metadata?: Record<string, any>;
  }>;
};

/**
 * Build the plain values object for inserting a new patient.
 * Returns a flat object with all fields populated (nulls for missing optional fields).
 * The caller is responsible for wrapping date/json fields with sql`` tagged templates.
 */
export function buildPatientInsertValues(
  input: CreatePatientInput["patient"],
  patientId?: string,
) {
  const id = patientId ?? uuidv7();
  return {
    id,
    given_name: input.given_name ?? null,
    surname: input.surname ?? null,
    date_of_birth: input.date_of_birth ?? null,
    sex: input.sex ?? null,
    citizenship: input.citizenship ?? null,
    hometown: input.hometown ?? null,
    phone: input.phone ?? null,
    camp: input.camp ?? null,
    government_id: input.government_id ?? null,
    external_patient_id: input.external_patient_id ?? null,
    additional_data: input.additional_data ?? {},
    metadata: input.metadata ?? {},
    photo_url: input.photo_url ?? null,
    primary_clinic_id: input.primary_clinic_id ?? null,
    is_deleted: false,
  };
}

/**
 * Build attribute insert values from the input array, binding each to the given patient ID.
 * Each attribute gets its own generated UUID.
 */
export function buildPatientAttributeInsertValues(
  patientId: string,
  attributes: NonNullable<CreatePatientInput["additionalAttributes"]>,
) {
  return attributes.map((attr) => ({
    id: uuidv7(),
    patient_id: patientId,
    attribute_id: attr.attribute_id,
    attribute: attr.attribute,
    number_value: attr.number_value ?? null,
    string_value: attr.string_value ?? null,
    date_value: attr.date_value ?? null,
    boolean_value: attr.boolean_value ?? null,
    metadata: attr.metadata ?? {},
    is_deleted: false,
  }));
}

/** Allowed fields for patient updates (excludes id, timestamps, is_deleted) */
const PATIENT_UPDATABLE_FIELDS = [
  "given_name",
  "surname",
  "date_of_birth",
  "sex",
  "citizenship",
  "hometown",
  "phone",
  "camp",
  "government_id",
  "external_patient_id",
  "additional_data",
  "metadata",
  "photo_url",
  "primary_clinic_id",
] as const;

/**
 * Build a partial update set from provided fields, filtering out undefined values.
 * Always includes updated_at and last_modified markers (as string sentinels the caller replaces with sql`now()`).
 */
export function buildPatientUpdateSet(
  fields: UpdatePatientInput["fields"],
): Record<string, any> {
  const updateSet: Record<string, any> = {};

  for (const key of PATIENT_UPDATABLE_FIELDS) {
    if (key in fields && fields[key] !== undefined) {
      updateSet[key] = fields[key];
    }
  }

  // Sentinel values — the caller replaces these with sql`now()::timestamp with time zone`
  updateSet._updated_at = "NOW";
  updateSet._last_modified = "NOW";

  return updateSet;
}

// ──────────────────────────────────────────────
// Visit types & builders
// ──────────────────────────────────────────────

export type CreateVisitInput = {
  patientId: string;
  clinicId: string;
  providerId: string;
  providerName?: string | null;
  checkInTimestamp?: string | null;
  metadata?: Record<string, any>;
};

/** Return a valid ISO timestamp string or null. Guards against NaN/invalid dates. */
function toValidTimestampOrNull(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : value;
}

/**
 * Build plain values object for inserting a new visit.
 */
export function buildVisitInsertValues(
  input: CreateVisitInput,
  visitId?: string,
) {
  const id = visitId ?? uuidv7();
  return {
    id,
    patient_id: input.patientId,
    clinic_id: input.clinicId,
    provider_id: input.providerId,
    provider_name: input.providerName ?? null,
    check_in_timestamp: toValidTimestampOrNull(input.checkInTimestamp),
    metadata: input.metadata ?? {},
    is_deleted: false,
  };
}

/**
 * Apply pagination defaults to raw input values.
 */
export function normalizePagination(
  offset?: number,
  limit?: number,
): { offset: number; limit: number } {
  return {
    offset: Math.max(0, offset ?? 0),
    limit: Math.max(1, limit ?? 50),
  };
}

// ──────────────────────────────────────────────
// Event types & builders
// ──────────────────────────────────────────────

export type CreateEventInput = {
  patientId: string;
  visitId: string;
  eventType?: string | null;
  formId?: string | null;
  formData: Array<Record<string, any>>;
  metadata?: Record<string, any>;
};

export type UpdateEventInput = {
  id: string;
  formData: Array<Record<string, any>>;
  metadata?: Record<string, any>;
};

/**
 * Build plain values object for inserting a new event.
 * The visitId is always required and never null.
 */
export function buildEventInsertValues(
  input: CreateEventInput,
  opts?: { eventId?: string; recordedByUserId?: string | null },
) {
  const id = opts?.eventId ?? uuidv7();
  return {
    id,
    patient_id: input.patientId,
    visit_id: input.visitId,
    event_type: input.eventType ?? null,
    form_id: input.formId ?? null,
    form_data: input.formData,
    metadata: input.metadata ?? {},
    is_deleted: false,
    recorded_by_user_id: opts?.recordedByUserId ?? null,
  };
}

/**
 * Build an update set for an event — only form_data and optionally metadata.
 * Returns the keys that should be set (caller wraps with sql`` for JSONB casting).
 */
export function buildEventUpdateSet(input: UpdateEventInput) {
  const result: {
    form_data: Array<Record<string, any>>;
    metadata?: Record<string, any>;
  } = {
    form_data: input.formData,
  };

  if (input.metadata !== undefined) {
    result.metadata = input.metadata;
  }

  return result;
}
