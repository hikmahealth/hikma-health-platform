/**
 * Wire-format normalisation shared by every sync path.
 *
 * The server speaks Postgres types (ISO date strings, JSONB objects); WatermelonDB
 * columns are numbers and strings. These helpers translate between the two and are
 * deliberately pure — no database handle, no transport, no peer state — so both the
 * legacy `peerSync` strategies and the newer manual-sync path can share one
 * implementation instead of drifting apart.
 *
 * Treat `updateDates` as reaching the server, not only the device. Its callers
 * today are all inbound pull payloads, but an outbound caller is easy to add and
 * the two directions are not symmetric: a server-only column such as
 * `image_timestamp` is dropped by `sanitizedRaw` inbound, while outbound it
 * arrives as 0 on a date column and nulls the server's value. Anything added
 * here must be safe both ways.
 */

import { SyncDatabaseChangeSet, SyncTableChangeSet } from "@nozbe/watermelondb/sync"
import * as Sentry from "@sentry/react-native"

import { toDateSafe } from "@/utils/date"
import { safeStringify } from "@/utils/parsers"

/**
 * Count the number of records inside a changeset.
 */
export const countRecordsInChanges = (changes: SyncDatabaseChangeSet): number => {
  let result = 0
  const c = changes as Record<string, SyncTableChangeSet>
  for (const tableName in c) {
    const table = c[tableName]
    if (!table || typeof table !== "object") continue
    const { created = [], updated = [], deleted = [] } = table
    result += created.length + updated.length + deleted.length
  }
  return result
}

/**
 * Converts a date value to a Unix timestamp (milliseconds).
 * Returns the fallback when the value is falsy, non-finite, or unparseable.
 *
 * Every fallback path reports to Sentry so silent data corruption is surfaced.
 */
export const convertToTimestamp = (
  value: unknown,
  fallback: Date,
  fieldName: string,
  recordId?: string,
): number => {
  const id = recordId ?? "unknown"

  if (!value && value !== 0) {
    Sentry.captureMessage(`Date fallback: missing ${fieldName} for record ${id}`, {
      level: "warning",
      tags: { component: "convertToTimestamp", fieldName },
      extra: { recordId: id, value },
    })
    return fallback.getTime()
  }

  if (typeof value === "boolean" || (typeof value === "object" && !(value instanceof Date))) {
    Sentry.captureMessage(`Date fallback: invalid type for ${fieldName} on record ${id}`, {
      level: "warning",
      tags: { component: "convertToTimestamp", fieldName },
      extra: { recordId: id, value, valueType: typeof value },
    })
    return fallback.getTime()
  }

  if (typeof value === "number" && !isFinite(value)) {
    Sentry.captureMessage(`Date fallback: non-finite ${fieldName} for record ${id}`, {
      level: "warning",
      tags: { component: "convertToTimestamp", fieldName },
      extra: { recordId: id, value },
    })
    return fallback.getTime()
  }

  try {
    const ts = new Date(value as string | number | Date).getTime()
    if (isNaN(ts)) {
      Sentry.captureMessage(`Date fallback: unparseable ${fieldName} for record ${id}: ${value}`, {
        level: "warning",
        tags: { component: "convertToTimestamp", fieldName },
        extra: { recordId: id, value },
      })
      return fallback.getTime()
    }
    return ts
  } catch (error) {
    Sentry.captureMessage(`Date fallback: exception parsing ${fieldName} for record ${id}`, {
      level: "warning",
      tags: { component: "convertToTimestamp", fieldName },
      extra: { recordId: id, value, error: String(error) },
    })
    return fallback.getTime()
  }
}

/**
 * In-place conversion of date strings → timestamps and JSON objects → stringified JSON
 * across all records in a WatermelonDB changeset.
 *
 * Note this mutates the records it is given, so callers holding live `_raw`
 * references must copy first.
 */
export const updateDates = (changes: SyncDatabaseChangeSet): void => {
  const defaultDate = new Date()
  const actions = ["created", "updated", "deleted"] as unknown as (keyof SyncTableChangeSet)[]
  const c = changes as Record<string, SyncTableChangeSet>

  for (const type of Object.keys(c)) {
    for (const action of actions) {
      if (!c[type][action]) continue
      ;(c[type][action] as any[]).forEach((record: any) => {
        // deleted arrays contain string IDs, not record objects — skip them
        if (typeof record === "string") return

        const recordId = record.id || "unknown"

        // Timestamps
        record.created_at = convertToTimestamp(
          record.created_at,
          defaultDate,
          "created_at",
          recordId,
        )
        record.updated_at = convertToTimestamp(
          record.updated_at,
          defaultDate,
          "updated_at",
          recordId,
        )
        if (record.deleted_at)
          record.deleted_at = convertToTimestamp(
            record.deleted_at,
            defaultDate,
            "deleted_at",
            recordId,
          )
        if (record.timestamp)
          record.timestamp = convertToTimestamp(
            record.timestamp,
            defaultDate,
            "timestamp",
            recordId,
          )
        if (record.prescribed_at)
          record.prescribed_at = convertToTimestamp(
            record.prescribed_at,
            defaultDate,
            "prescribed_at",
            recordId,
          )
        if (record.filled_at)
          record.filled_at = convertToTimestamp(
            record.filled_at,
            defaultDate,
            "filled_at",
            recordId,
          )
        if (record.expiration_date)
          record.expiration_date = convertToTimestamp(
            record.expiration_date,
            defaultDate,
            "expiration_date",
            recordId,
          )
        if (record.batch_expiry_date)
          record.batch_expiry_date = convertToTimestamp(
            record.batch_expiry_date,
            defaultDate,
            "batch_expiry_date",
            recordId,
          )
        if (record.check_in_timestamp)
          record.check_in_timestamp = convertToTimestamp(
            record.check_in_timestamp,
            defaultDate,
            "check_in_timestamp",
            recordId,
          )
        // patient_risk_profiles: server stores this as a timestamptz, mobile as a
        // Unix timestamp number.
        if (record.datetime_value)
          record.datetime_value = convertToTimestamp(
            record.datetime_value,
            defaultDate,
            "datetime_value",
            recordId,
          )

        // `image_timestamp` is deliberately NOT touched here. It is a server-only
        // column absent from the mobile schema; zeroing it did nothing inbound but
        // wiped the server's value on any outbound path that ran this.

        // ── JSON fields (JSONB → string for WatermelonDB) ───────────
        if (record.departments) record.departments = safeStringify(record.departments, "[]")
        if (record.metadata) record.metadata = safeStringify(record.metadata, "{}")
        // json_value is a jsonb column on the server; serialize it so WatermelonDB
        // can store it in its text column. Use != null so falsy JSON primitives
        // (false, 0) are still stringified rather than left as raw JS values.
        if (record.json_value != null) record.json_value = safeStringify(record.json_value, "null")
        if (record.form_fields) record.form_fields = safeStringify(record.form_fields, "[]")
        if (record.translations) record.translations = safeStringify(record.translations, "[]")
        // The falsy guard is load-bearing for app_config.clinic_ids: it lets
        // null survive as null, meaning "applies to all clinics". Widening it to
        // `!== undefined` would rewrite that to "[]" — "applies to no clinic" —
        // disabling every global config row.
        if (record.clinic_ids) record.clinic_ids = safeStringify(record.clinic_ids, "[]")
        if (record.form_data) record.form_data = safeStringify(record.form_data, "[]")
        if (record.fields) record.fields = safeStringify(record.fields, "[]")

        // date_of_birth (stored as "YYYY-MM-DD" string, not timestamp)
        if (record.date_of_birth !== undefined && record.date_of_birth !== null) {
          try {
            const dob = record.date_of_birth
            if (typeof dob === "string" && dob.trim() === "") {
              record.date_of_birth = null
            } else if (typeof dob === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
              const [y, m, d] = dob.split("-").map(Number)
              record.date_of_birth = y === 0 && m === 0 && d === 0 ? null : dob
            } else {
              const date = toDateSafe(dob, new Date())
              if (isNaN(date.getTime())) {
                record.date_of_birth = null
              } else {
                const year = date.getUTCFullYear()
                const month = String(date.getUTCMonth() + 1).padStart(2, "0")
                const day = String(date.getUTCDate()).padStart(2, "0")
                record.date_of_birth = `${year}-${month}-${day}`
              }
            }
          } catch {
            record.date_of_birth = null
          }
        }
      })
    }
  }
}
