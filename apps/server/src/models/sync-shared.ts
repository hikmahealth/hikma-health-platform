import { sql, type AliasedRawBuilder } from "kysely";
import { Logger } from "@hikmahealth/js-utils";
import { civilDateFromLocalDate } from "@/lib/utils";
import Patient from "./patient";
import PatientAdditionalAttribute from "./patient-additional-attribute";
import Clinic from "./clinic";
import Visit from "./visit";
import Event from "./event";
import EventForm from "./event-form";
import PatientRegistrationForm from "./patient-registration-form";
import Appointment from "./appointment";
import Prescription from "./prescription";
import PatientVital from "./patient-vital";
import PatientProblem from "./patient-problem";
import ClinicDepartment from "./clinic-department";
import DrugCatalogue from "./drug-catalogue";
import ClinicInventory from "./clinic-inventory";
import DispensingRecord from "./dispensing-records";
import PrescriptionItem from "./prescription-items";
import User from "./user";
import Device from "./device";
import DevicePinCode from "./device-pin-code";
import PatientRiskProfile from "./patient-risk-profile";

/**
 * These entities are synced to mobile. They should not contain information that is not needed for mobile use.
 * When adding new entities that need to be synced to mobile, add them to ENTITIES_TO_PUSH_TO_MOBILE
 * `User` rides here only through `MOBILE_SYNC_COLUMNS` — read that first.
 *
 * Deliberately unannotated: `PostTableName` is derived from
 * `ENTITIES_TO_PULL_FROM_MOBILE[number]["Table"]["name"]`, so a `: SyncEntity[]`
 * annotation would widen every table name to `string` and silently strip
 * exhaustiveness from the `Record<PostTableName, …>` lookups. It would still
 * compile. Use `SyncEntity` for parameters and return types only.
 */
export const ENTITIES_TO_PUSH_TO_MOBILE = [
  Patient,
  PatientAdditionalAttribute,
  PatientRiskProfile,
  Clinic,
  Visit,
  Event,
  EventForm,
  PatientRegistrationForm,
  Appointment,
  Prescription,
  PatientVital,
  PatientProblem,
  ClinicDepartment,
  DrugCatalogue,
  ClinicInventory,
  DispensingRecord,
  PrescriptionItem,
  User,
  // Add more syncable entities here. Do not add any server defined entities here that do not track server_created_at or server_updated_at
];

/**
 * These entities are synced to the local sync hub. They contain a subset of the information available in the server for the respective clinics the sync hub is allowed to store data for.
 * Syncing users is allowed.
 *
 * When adding new entities that need to be synced to the hubs, add them to ENTITIES_TO_PUSH_TO_HUB
 */
// `User` comes in via the mobile list. Hubs still get whole rows — the column
// projection applies to mobile peers only.
export const ENTITIES_TO_PUSH_TO_HUB = [
  ...ENTITIES_TO_PUSH_TO_MOBILE,
  Device,
  DevicePinCode,
];

/**
 * These entities are synced from mobile.
 * When adding new entities that need to be synced from mobile, add them to ENTITIES_TO_PULL_FROM_MOBILE
 *
 * NOTE: Not going to sync the following from mobile, they will just be ignored
 * 1. DrugCatalogue
 * 2. ClinicInventory
 * 3. Clinic
 * 4. User
 * 5. PatientRegistrationForm
 * 6. EventForm
 * 7. PatientRiskProfile — server-managed, one-way push to mobile only
 */
export const ENTITIES_TO_PULL_FROM_MOBILE = [
  Patient,
  PatientAdditionalAttribute,
  PatientRiskProfile,
  Visit,
  Event,
  Appointment,
  Prescription,
  PatientVital,
  PatientProblem,
  PrescriptionItem,
  DispensingRecord,
];

/**
 * These entities are accepted from sync hubs. Hubs relay data from mobile
 * devices and may also manage clinic-level configuration locally, so they
 * can push a superset of what mobile pushes.
 */
export const ENTITIES_TO_PULL_FROM_HUB = [
  ...ENTITIES_TO_PULL_FROM_MOBILE,
  ClinicDepartment,
  DrugCatalogue,
  DevicePinCode,
];

/**
 * The subset of a model's `Table` namespace that sync depends on.
 *
 * `mobileName` is optional because `Device.Table` does not declare one; it is
 * reachable through ENTITIES_TO_PUSH_TO_HUB, so requiring it here would not
 * typecheck.
 */
export type SyncEntity = {
  Table: {
    name: string;
    mobileName?: string;
    ALWAYS_PUSH_TO_MOBILE?: boolean;
  };
};

/**
 * Which entities apply for a given peer, in a given direction.
 *
 * "push" = server → client (what we send them).
 * "pull" = client → server (what we accept from them), deliberately narrower:
 * a mobile device may not write reference data such as clinics or drug_catalogue.
 *
 * Any peer type other than sync_hub is treated as mobile, which is the safe
 * default — an unrecognised peer gets the smaller set in both directions.
 */
export function resolveEntitiesForPeer(
  peerType: Device.DeviceTypeT,
  direction: "push" | "pull",
): SyncEntity[] {
  const isHub = peerType === "sync_hub";
  if (direction === "push") {
    return isHub ? ENTITIES_TO_PUSH_TO_HUB : ENTITIES_TO_PUSH_TO_MOBILE;
  }
  return isHub ? ENTITIES_TO_PULL_FROM_HUB : ENTITIES_TO_PULL_FROM_MOBILE;
}

/** Configuration entities that should always sync full history (exempt from MAX_HISTORY_DAYS_SYNC) */
export const EXEMPT_FROM_HISTORY_LIMIT = [
  "clinics",
  // Patient registration forms have different names on mobile and on server, thus both are listed in the exemption list
  "patient_registration_forms",
  "registration_forms",
  "event_forms",
  "drug_catalogue",
  "clinic_departments",
  "clinic_inventory", // this should synced for just the signed in clinic??
];

/**
 * Validates and retrieves the MAX_HISTORY_DAYS_SYNC environment variable
 * @returns The number of days to limit history sync, or null if not set
 * @throws Error if the value is present but not a valid positive number
 */
export const getMaxHistoryDaysSync = (): number | null => {
  const envValue = process.env.MAX_HISTORY_DAYS_SYNC;

  if (!envValue) {
    return null;
  }

  const days = Number(envValue);

  if (isNaN(days) || days <= 0 || !Number.isInteger(days)) {
    Logger.error(
      `MAX_HISTORY_DAYS_SYNC must be a valid positive integer, got: ${envValue}. Ignoring and using no limit.`,
    );
    return null;
  }

  return days;
};

/**
 * Columns holding a *civil date*, which must reach the client as "YYYY-MM-DD"
 * and never as an instant. Both pull queries are generic `selectAll()`s, so `pg`
 * hands these over as local-midnight Dates that JSON would serialize through
 * toISOString(), shifting the day on any server not running on UTC.
 *
 * Deliberately narrower than `isDateColumn`, which also covers instants that
 * SHOULD be sent as ISO strings. The schema's other `date` columns (onset_date,
 * end_date, batch_expiry_date, …) are civil dates too, but their models type
 * them as `Date` and mobile expects that shape, so they are a separate change.
 *
 * Both pull paths must apply this. The paged one carries a device's first sync,
 * and a row it delivers unnormalized is never corrected — the ordinary pull only
 * re-sends rows that change again.
 */
export const CIVIL_DATE_COLUMNS_BY_TABLE: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([["patients", new Set(["date_of_birth"])]]);

/**
 * Rewrite this table's civil-date columns to "YYYY-MM-DD" in place of the Date
 * objects `pg` produced. Returns the rows unchanged when the table has none, and
 * tolerates a projection that omits one — the paged pull's `deleted` bucket
 * selects only (id, deleted_at).
 */
export const normalizeCivilDates = <T extends Record<string, any>>(
  tableName: string,
  rows: T[],
): T[] => {
  const columns = CIVIL_DATE_COLUMNS_BY_TABLE.get(tableName);
  if (!columns) return rows;
  return rows.map((row) => {
    let next: T | null = null;
    for (const column of columns) {
      if (!(column in row)) continue;
      const civil = civilDateFromLocalDate(row[column]);
      if (civil === row[column]) continue;
      next ??= { ...row };
      (next as Record<string, any>)[column] = civil;
    }
    return next ?? row;
  });
};

/**
 * Tables replicated in full on every pull instead of as a delta.
 *
 * A delta delivers a row exactly once, so a device that misses that window never
 * sees it again. Mobile resolves references through `findAndObserve`, which
 * throws when the row is absent and takes down the screen rather than the one
 * row. Re-sending makes any such loss self-correcting.
 *
 * Still subject to `applyClinicScope`, so this restores a row a device was
 * entitled to and dropped — it does not widen anyone's entitlement. Safe to
 * re-send: neither `Clinic` nor `User` is in `ENTITIES_TO_PULL_FROM_MOBILE`, so
 * a snapshot cannot clobber a local edit.
 *
 * `users` needs this because user rows almost never change: a watermarked delta
 * would leave a long-lived install permanently missing the names of everyone not
 * edited since it last synced.
 *
 * Implemented twice — `getFullSnapshot` in sync.ts and the `isSnapshot` branches
 * of `fetchBucket` in sync-paged.ts. Both, or the guarantee is false.
 */
export const FULL_SNAPSHOT_TABLES: ReadonlySet<string> = new Set([
  "clinics",
  "users",
]);

/** Stands in for a column a device may not see, and reads as deliberate. */
export const MASKED_VALUE = "********";

/**
 * What a mobile peer receives for a table, in place of every column. Tables
 * absent from here are sent whole, and hubs are never projected.
 *
 * An allowlist, not a denylist: a column added to Postgres later stays off
 * devices until someone lists it here. `users` is why this exists — the row
 * carries `hashed_password` and `instance_url`, and a device needs only enough
 * to resolve `events.recorded_by_user_id` to a provider's name.
 *
 * Applied in SQL, so a withheld value never leaves Postgres. Sync bypasses the
 * Schema models, so this is the only restriction on the cloud path — the hub
 * has its own in `local-hub/.../rpc/handlers/sync.rs`.
 */
export const MOBILE_SYNC_COLUMNS: Record<
  string,
  { readonly columns: readonly string[]; readonly masked: readonly string[] }
> = {
  users: {
    columns: [
      "id",
      "name",
      "role",
      "clinic_id",
      "is_deleted",
      "created_at",
      "updated_at",
      "last_modified",
      "server_created_at",
      "deleted_at",
    ],
    masked: ["email"],
  },
};

/**
 * The select list for a table and peer, or null to select every column. Any peer
 * that is not a hub is treated as mobile, matching `resolveEntitiesForPeer`.
 */
export function syncSelection(
  table: string,
  peerType: Device.DeviceTypeT,
): Array<string | AliasedRawBuilder<string, string>> | null {
  if (peerType === "sync_hub") return null;

  // Own keys only: a plain object literal resolves "constructor"/"valueOf" off
  // Object.prototype, and spreading the absent `.columns` throws.
  if (!Object.hasOwn(MOBILE_SYNC_COLUMNS, table)) return null;
  const projection = MOBILE_SYNC_COLUMNS[table];

  return [
    ...projection.columns,
    ...projection.masked.map((column) => sql.lit(MASKED_VALUE).as(column)),
  ];
}

// Maps server table names to their clinic column for hub scoping.
// Tables not listed here have no direct clinic association and sync unfiltered.
export const CLINIC_COLUMN_BY_TABLE: Record<string, string> = {
  patients: "primary_clinic_id",
  visits: "clinic_id",
  appointments: "clinic_id",
  prescriptions: "pickup_clinic_id",
  clinic_departments: "clinic_id",
  clinic_inventory: "clinic_id",
  dispensing_records: "clinic_id",
  prescription_items: "clinic_id",
  patient_registration_forms: "clinic_id",
  patient_risk_profiles: "clinic_id",
  users: "clinic_id",
  user_clinic_permissions: "clinic_id",
};

// Tables whose clinic association is stored as an array rather than a single column.
export const CLINIC_ARRAY_TABLES: Record<
  string,
  { column: string; type: "jsonb" | "pg_array" }
> = {
  event_forms: { column: "clinic_ids", type: "jsonb" },
  devices: { column: "clinic_ids", type: "pg_array" },
};

/**
 * Applies clinic-scoped filtering to a Kysely query builder for hub pulls.
 * Returns the query unchanged when clinicIds is null (non-hub peers).
 */
export function applyClinicScope<Q>(
  query: Q,
  tableName: string,
  clinicIds: string[] | null,
): Q {
  if (!clinicIds || clinicIds.length === 0) return query;

  // Clinics table: filter by id directly
  if (tableName === "clinics") {
    return (query as any).where("id", "in", clinicIds);
  }

  // Simple column filter (clinic_id, primary_clinic_id, etc.)
  const clinicColumn = CLINIC_COLUMN_BY_TABLE[tableName];
  if (clinicColumn) {
    return (query as any).where(clinicColumn, "in", clinicIds);
  }

  // Array-based clinic associations
  const arrayConfig = CLINIC_ARRAY_TABLES[tableName];
  if (arrayConfig) {
    const idsLiteral = `{${clinicIds.join(",")}}`;
    if (arrayConfig.type === "jsonb") {
      // JSONB array: include records with empty/null clinic_ids (available to all clinics)
      // or those whose clinic_ids overlap with the hub's clinics via ?| operator
      return (query as any).where(
        sql`(${sql.ref(arrayConfig.column)} IS NULL OR ${sql.ref(arrayConfig.column)} = '[]'::jsonb OR ${sql.ref(arrayConfig.column)} ?| ${idsLiteral}::text[])`,
      );
    }
    // PostgreSQL native uuid[] array: use && overlap operator
    return (query as any).where(
      sql`${sql.ref(arrayConfig.column)} && ${idsLiteral}::uuid[]`,
    );
  }

  // No clinic association (e.g. patient_additional_attributes, events, drug_catalogue) — no filtering
  return query;
}
