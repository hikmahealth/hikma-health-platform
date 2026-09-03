import { Q } from "@nozbe/watermelondb"
import { Option } from "effect"

import database from "@/db"
import PatientRiskProfileModel from "@/db/model/PatientRiskProfile"
import { isValidUUID } from "@/utils/misc"

namespace PatientRiskProfile {
  // Mirrors the value_type enum defined in the server migration.
  export type ProfileValueType = "string" | "numeric" | "integer" | "boolean" | "datetime" | "json"

  export type T = {
    id: string
    patientId: string
    clinicId: Option.Option<string>
    kind: string
    source: string
    target: Option.Option<string>
    version: string
    valueType: ProfileValueType
    stringValue: Option.Option<string>
    booleanValue: Option.Option<boolean>
    integerValue: Option.Option<number>
    /** Stored as a string to preserve server-side decimal(31,10) precision. */
    numericalValue: Option.Option<string>
    datetimeValue: Option.Option<Date>
    /** Stored as a JSON string. */
    jsonValue: Option.Option<string>
    /** Stored as a JSON string. */
    metadata: Option.Option<string>
    isDeleted: boolean
    createdAt: Date
    updatedAt: Date
    deletedAt: Option.Option<Date>
  }

  /** Default empty instance. */
  export const empty: T = {
    id: "",
    patientId: "",
    clinicId: Option.none(),
    kind: "",
    source: "",
    target: Option.none(),
    version: "",
    valueType: "string",
    stringValue: Option.none(),
    booleanValue: Option.none(),
    integerValue: Option.none(),
    numericalValue: Option.none(),
    datetimeValue: Option.none(),
    jsonValue: Option.none(),
    metadata: Option.none(),
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: Option.none(),
  }

  /**
   * Return the typed value of a profile entry regardless of which value column
   * is populated, or `null` when the column for the declared type is empty.
   */
  export const getValue = (attr: T): string | number | boolean | Date | null => {
    switch (attr.valueType) {
      case "string":
        return Option.getOrNull(attr.stringValue)
      case "numeric":
        return Option.getOrNull(attr.numericalValue)
      case "integer":
        return Option.getOrNull(attr.integerValue)
      case "boolean":
        return Option.getOrNull(attr.booleanValue)
      case "datetime":
        return Option.getOrNull(attr.datetimeValue)
      case "json":
        return Option.getOrNull(attr.jsonValue)
    }
  }

  export namespace DB {
    export type T = PatientRiskProfileModel

    export type NewAttribute = {
      patientId: string
      clinicId?: string
      kind: string
      source: string
      target?: string
      version: string
      valueType: ProfileValueType
      stringValue?: string
      booleanValue?: boolean
      integerValue?: number
      numericalValue?: string
      datetimeValue?: Date
      jsonValue?: string
      metadata?: string
    }

    /**
     * Build an unsaved record for use inside a `database.batch` call.
     * `clinic_id` is a uuid column server-side, so a non-UUID value is dropped
     * rather than written (an invalid uuid fails the sync push).
     *
     * @throws If `patientId` is not a valid UUID
     */
    export const prepareCreate = (attr: NewAttribute): PatientRiskProfileModel => {
      if (!isValidUUID(attr.patientId)) {
        throw new Error(
          `Cannot create a patient risk profile without a valid patient_id (got "${attr.patientId}")`,
        )
      }

      return database
        .get<PatientRiskProfileModel>("patient_risk_profiles")
        .prepareCreate((record) => {
          record.patientId = attr.patientId
          record.clinicId = isValidUUID(attr.clinicId ?? "") ? attr.clinicId : undefined
          record.kind = attr.kind
          record.source = attr.source
          record.target = attr.target
          record.version = attr.version
          record.valueType = attr.valueType
          record.stringValue = attr.stringValue
          record.booleanValue = attr.booleanValue
          record.integerValue = attr.integerValue
          record.numericalValue = attr.numericalValue
          record.datetimeValue = attr.datetimeValue
          record.jsonValue = attr.jsonValue
          record.metadata = attr.metadata
          record.isDeleted = false
        })
    }

    /**
     * Create a new patient risk profile entry.
     * @returns The ID of the created record.
     */
    export const create = async (attr: NewAttribute): Promise<string> => {
      return await database.write(async () => {
        const record = await database
          .get<PatientRiskProfileModel>("patient_risk_profiles")
          .create((r) => {
            r.patientId = attr.patientId
            r.clinicId = isValidUUID(attr.clinicId ?? "") ? attr.clinicId : undefined
            r.kind = attr.kind
            r.source = attr.source
            r.target = attr.target
            r.version = attr.version
            r.valueType = attr.valueType
            r.stringValue = attr.stringValue
            r.booleanValue = attr.booleanValue
            r.integerValue = attr.integerValue
            r.numericalValue = attr.numericalValue
            r.datetimeValue = attr.datetimeValue
            r.jsonValue = attr.jsonValue
            r.metadata = attr.metadata
            r.isDeleted = false
          })

        return record.id
      })
    }

    /**
     * Update value fields on an existing profile record.
     * Only fields present in `updates` are touched.
     * @returns The ID of the updated record.
     */
    export const update = async (
      profileId: string,
      updates: Partial<
        Pick<
          NewAttribute,
          | "valueType"
          | "target"
          | "version"
          | "stringValue"
          | "booleanValue"
          | "integerValue"
          | "numericalValue"
          | "datetimeValue"
          | "jsonValue"
          | "metadata"
        >
      >,
    ): Promise<string> => {
      return await database.write(async () => {
        const record = await database
          .get<PatientRiskProfileModel>("patient_risk_profiles")
          .find(profileId)

        const updated = await record.update((r) => {
          if (updates.valueType !== undefined) r.valueType = updates.valueType
          if (updates.target !== undefined) r.target = updates.target
          if (updates.version !== undefined) r.version = updates.version
          if (updates.stringValue !== undefined) r.stringValue = updates.stringValue
          if (updates.booleanValue !== undefined) r.booleanValue = updates.booleanValue
          if (updates.integerValue !== undefined) r.integerValue = updates.integerValue
          if (updates.numericalValue !== undefined) r.numericalValue = updates.numericalValue
          if (updates.datetimeValue !== undefined) r.datetimeValue = updates.datetimeValue
          if (updates.jsonValue !== undefined) r.jsonValue = updates.jsonValue
          if (updates.metadata !== undefined) r.metadata = updates.metadata
        })

        return updated.id
      })
    }

    /**
     * Upsert a risk profile by its unique key (patient + kind + source).
     * Creates a new record if none exists, otherwise updates the existing one.
     * @returns The ID of the created or updated record.
     */
    export const upsert = async (attr: NewAttribute): Promise<string> => {
      const existing = await database
        .get<PatientRiskProfileModel>("patient_risk_profiles")
        .query(
          Q.where("patient_id", attr.patientId),
          Q.where("kind", attr.kind),
          Q.where("source", attr.source),
          Q.where("is_deleted", false),
        )
        .fetch()

      if (existing.length > 0) {
        return update(existing[0].id, {
          valueType: attr.valueType,
          target: attr.target,
          version: attr.version,
          stringValue: attr.stringValue,
          booleanValue: attr.booleanValue,
          integerValue: attr.integerValue,
          numericalValue: attr.numericalValue,
          datetimeValue: attr.datetimeValue,
          jsonValue: attr.jsonValue,
          metadata: attr.metadata,
        })
      }

      return create(attr)
    }

    /**
     * Soft-delete profile records. Uses `markAsDeleted` so the sync engine
     * places them in the deleted bucket and the server sets `deleted_at`.
     */
    export const softDelete = async (records: PatientRiskProfileModel[]): Promise<void> => {
      for (const record of records) {
        await record.update((r) => {
          r.isDeleted = true
        })
        await record.markAsDeleted()
      }
    }

    /**
     * Get all active risk profiles for a patient, optionally filtered by clinic.
     */
    export const getAllForPatient = async (
      patientId: string,
      clinicId?: string,
    ): Promise<PatientRiskProfile.T[]> => {
      const conditions = [Q.where("patient_id", patientId), Q.where("is_deleted", false)]

      if (clinicId !== undefined) {
        conditions.push(Q.where("clinic_id", clinicId))
      }

      const records = await database
        .get<PatientRiskProfileModel>("patient_risk_profiles")
        .query(...conditions)
        .fetch()

      return records.map(fromDB)
    }

    /**
     * Get a single profile by patient + kind + source.
     * Returns `Option.none()` if no matching record exists.
     */
    export const getByKey = async (
      patientId: string,
      kind: string,
      source: string,
      clinicId?: string,
    ): Promise<Option.Option<PatientRiskProfile.T>> => {
      const conditions = [
        Q.where("patient_id", patientId),
        Q.where("kind", kind),
        Q.where("source", source),
        Q.where("is_deleted", false),
      ]

      if (clinicId !== undefined) {
        conditions.push(Q.where("clinic_id", clinicId))
      }

      const records = await database
        .get<PatientRiskProfileModel>("patient_risk_profiles")
        .query(...conditions)
        .fetch()

      return records.length > 0 ? Option.some(fromDB(records[0])) : Option.none()
    }

    /**
     * Subscribe to live updates of a patient's risk profiles.
     */
    export function subscribe(
      patientId: string,
      callback: (attrs: Option.Option<PatientRiskProfile.T[]>, isLoading: boolean) => void,
    ): { unsubscribe: () => void } {
      let isLoading = true

      const subscription = database
        .get<PatientRiskProfileModel>("patient_risk_profiles")
        .query(Q.where("patient_id", patientId), Q.where("is_deleted", false))
        .observe()
        .subscribe((dbRecords) => {
          isLoading = false
          callback(Option.fromNullable(dbRecords.map(fromDB)), isLoading)
        })

      return { unsubscribe: () => subscription.unsubscribe() }
    }

    /** Map a WatermelonDB model row to the plain `PatientRiskProfile.T` type. */
    export const fromDB = (record: DB.T): PatientRiskProfile.T => ({
      id: record.id,
      patientId: record.patientId,
      clinicId: Option.fromNullable(record.clinicId),
      kind: record.kind,
      source: record.source,
      target: Option.fromNullable(record.target),
      version: record.version,
      valueType: record.valueType as ProfileValueType,
      stringValue: Option.fromNullable(record.stringValue),
      booleanValue: Option.fromNullable(record.booleanValue),
      integerValue: Option.fromNullable(record.integerValue),
      numericalValue: Option.fromNullable(record.numericalValue),
      datetimeValue: Option.fromNullable(record.datetimeValue),
      jsonValue: Option.fromNullable(record.jsonValue),
      metadata: Option.fromNullable(record.metadata),
      isDeleted: record.isDeleted,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: Option.fromNullable(record.deletedAt),
    })
  }
}

export default PatientRiskProfile
