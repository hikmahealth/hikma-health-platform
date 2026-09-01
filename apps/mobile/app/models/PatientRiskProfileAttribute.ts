import { Q } from "@nozbe/watermelondb"
import { Option } from "effect"

import database from "@/db"
import PatientRiskProfileAttributeModel from "@/db/model/PatientRiskProfileAttribute"
import { isValidUUID } from "@/utils/misc"

namespace PatientRiskProfileAttribute {
  // Mirrors the profile_value_type enum defined in the server migration.
  export type ProfileValueType = "string" | "numeric" | "integer" | "boolean" | "datetime"

  export type T = {
    id: string
    patientId: string
    clinicId: Option.Option<string>
    profileKey: string
    uniqueReference: Option.Option<string>
    profileValueType: ProfileValueType
    stringValue: Option.Option<string>
    booleanValue: Option.Option<boolean>
    integerValue: Option.Option<number>
    /** Stored as a string to preserve server-side decimal(31,10) precision. */
    numericalValue: Option.Option<string>
    datetimeValue: Option.Option<Date>
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
    profileKey: "",
    uniqueReference: Option.none(),
    profileValueType: "string",
    stringValue: Option.none(),
    booleanValue: Option.none(),
    integerValue: Option.none(),
    numericalValue: Option.none(),
    datetimeValue: Option.none(),
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: Option.none(),
  }

  /**
   * Return the typed value of an attribute regardless of which value column is
   * populated, or `null` when the column for the declared type is empty.
   */
  export const getValue = (attr: T): string | number | boolean | Date | null => {
    switch (attr.profileValueType) {
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
    }
  }

  export namespace DB {
    export type T = PatientRiskProfileAttributeModel

    export type NewAttribute = {
      patientId: string
      clinicId?: string
      profileKey: string
      uniqueReference?: string
      profileValueType: ProfileValueType
      stringValue?: string
      booleanValue?: boolean
      integerValue?: number
      numericalValue?: string
      datetimeValue?: Date
    }

    /**
     * Build an unsaved record for use inside a `database.batch` call.
     * `clinic_id` is a uuid column server-side, so a non-UUID value is dropped
     * rather than written (an invalid uuid fails the sync push).
     *
     * @throws If `patientId` is not a valid UUID
     */
    export const prepareCreate = (attr: NewAttribute): PatientRiskProfileAttributeModel => {
      if (!isValidUUID(attr.patientId)) {
        throw new Error(
          `Cannot create a patient risk profile attribute without a valid patient_id (got "${attr.patientId}")`,
        )
      }

      return database
        .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
        .prepareCreate((record) => {
          record.patientId = attr.patientId
          record.clinicId = isValidUUID(attr.clinicId ?? "") ? attr.clinicId : undefined
          record.profileKey = attr.profileKey
          record.uniqueReference = attr.uniqueReference
          record.profileValueType = attr.profileValueType
          record.stringValue = attr.stringValue
          record.booleanValue = attr.booleanValue
          record.integerValue = attr.integerValue
          record.numericalValue = attr.numericalValue
          record.datetimeValue = attr.datetimeValue
          record.isDeleted = false
        })
    }

    /**
     * Create a new patient risk profile attribute.
     * @returns The ID of the created record.
     */
    export const create = async (attr: NewAttribute): Promise<string> => {
      return await database.write(async () => {
        const record = await database
          .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
          .create((r) => {
            r.patientId = attr.patientId
            r.clinicId = isValidUUID(attr.clinicId ?? "") ? attr.clinicId : undefined
            r.profileKey = attr.profileKey
            r.uniqueReference = attr.uniqueReference
            r.profileValueType = attr.profileValueType
            r.stringValue = attr.stringValue
            r.booleanValue = attr.booleanValue
            r.integerValue = attr.integerValue
            r.numericalValue = attr.numericalValue
            r.datetimeValue = attr.datetimeValue
            r.isDeleted = false
          })

        return record.id
      })
    }

    /**
     * Update value fields on an existing attribute record.
     * Only fields present in `updates` are touched.
     * @returns The ID of the updated record.
     */
    export const update = async (
      attributeId: string,
      updates: Partial<
        Pick<
          NewAttribute,
          | "profileValueType"
          | "stringValue"
          | "booleanValue"
          | "integerValue"
          | "numericalValue"
          | "datetimeValue"
          | "uniqueReference"
        >
      >,
    ): Promise<string> => {
      return await database.write(async () => {
        const record = await database
          .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
          .find(attributeId)

        const updated = await record.update((r) => {
          if (updates.profileValueType !== undefined) r.profileValueType = updates.profileValueType
          if (updates.uniqueReference !== undefined) r.uniqueReference = updates.uniqueReference
          if (updates.stringValue !== undefined) r.stringValue = updates.stringValue
          if (updates.booleanValue !== undefined) r.booleanValue = updates.booleanValue
          if (updates.integerValue !== undefined) r.integerValue = updates.integerValue
          if (updates.numericalValue !== undefined) r.numericalValue = updates.numericalValue
          if (updates.datetimeValue !== undefined) r.datetimeValue = updates.datetimeValue
        })

        return updated.id
      })
    }

    /**
     * Upsert a risk profile attribute by its unique key (patient + clinic + profileKey).
     * Creates a new record if none exists, otherwise updates the existing one.
     * @returns The ID of the created or updated record.
     */
    export const upsert = async (attr: NewAttribute): Promise<string> => {
      const existing = await database
        .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
        .query(
          Q.where("patient_id", attr.patientId),
          Q.where("clinic_id", attr.clinicId ?? null),
          Q.where("profile_key", attr.profileKey),
          Q.where("is_deleted", false),
        )
        .fetch()

      if (existing.length > 0) {
        return update(existing[0].id, {
          profileValueType: attr.profileValueType,
          uniqueReference: attr.uniqueReference,
          stringValue: attr.stringValue,
          booleanValue: attr.booleanValue,
          integerValue: attr.integerValue,
          numericalValue: attr.numericalValue,
          datetimeValue: attr.datetimeValue,
        })
      }

      return create(attr)
    }

    /**
     * Soft-delete attribute records. Uses `markAsDeleted` so the sync engine
     * places them in the deleted bucket and the server sets `deleted_at`.
     */
    export const softDelete = async (
      records: PatientRiskProfileAttributeModel[],
    ): Promise<void> => {
      for (const record of records) {
        await record.update((r) => {
          r.isDeleted = true
        })
        await record.markAsDeleted()
      }
    }

    /**
     * Get all active risk profile attributes for a patient, optionally filtered
     * by clinic.
     */
    export const getAllForPatient = async (
      patientId: string,
      clinicId?: string,
    ): Promise<PatientRiskProfileAttribute.T[]> => {
      const conditions = [Q.where("patient_id", patientId), Q.where("is_deleted", false)]

      if (clinicId !== undefined) {
        conditions.push(Q.where("clinic_id", clinicId))
      }

      const records = await database
        .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
        .query(...conditions)
        .fetch()

      return records.map(fromDB)
    }

    /**
     * Get a single attribute by patient + clinic + profile key.
     * Returns `Option.none()` if no matching record exists.
     */
    export const getByKey = async (
      patientId: string,
      profileKey: string,
      clinicId?: string,
    ): Promise<Option.Option<PatientRiskProfileAttribute.T>> => {
      const records = await database
        .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
        .query(
          Q.where("patient_id", patientId),
          Q.where("clinic_id", clinicId ?? null),
          Q.where("profile_key", profileKey),
          Q.where("is_deleted", false),
        )
        .fetch()

      return records.length > 0 ? Option.some(fromDB(records[0])) : Option.none()
    }

    /**
     * Subscribe to live updates of a patient's risk profile attributes.
     */
    export function subscribe(
      patientId: string,
      callback: (attrs: Option.Option<PatientRiskProfileAttribute.T[]>, isLoading: boolean) => void,
    ): { unsubscribe: () => void } {
      let isLoading = true

      const subscription = database
        .get<PatientRiskProfileAttributeModel>("patient_risk_profile_attributes")
        .query(Q.where("patient_id", patientId), Q.where("is_deleted", false))
        .observe()
        .subscribe((dbRecords) => {
          isLoading = false
          callback(Option.fromNullable(dbRecords.map(fromDB)), isLoading)
        })

      return { unsubscribe: () => subscription.unsubscribe() }
    }

    /** Map a WatermelonDB model row to the plain `PatientRiskProfileAttribute.T` type. */
    export const fromDB = (record: DB.T): PatientRiskProfileAttribute.T => ({
      id: record.id,
      patientId: record.patientId,
      clinicId: Option.fromNullable(record.clinicId),
      profileKey: record.profileKey,
      uniqueReference: Option.fromNullable(record.uniqueReference),
      profileValueType: record.profileValueType as ProfileValueType,
      stringValue: Option.fromNullable(record.stringValue),
      booleanValue: Option.fromNullable(record.booleanValue),
      integerValue: Option.fromNullable(record.integerValue),
      numericalValue: Option.fromNullable(record.numericalValue),
      datetimeValue: Option.fromNullable(record.datetimeValue),
      isDeleted: record.isDeleted,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: Option.fromNullable(record.deletedAt),
    })
  }
}

export default PatientRiskProfileAttribute
