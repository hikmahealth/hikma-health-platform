import { Q } from "@nozbe/watermelondb"
import * as Sentry from "@sentry/react-native"
import { format, isValid } from "date-fns"
import { Either, Option } from "effect"
import { camelCase } from "es-toolkit/compat"
import { catchError, of as of$ } from "@nozbe/watermelondb/utils/rx"

import database from "@/db"
import AppointmentModel from "@/db/model/Appointment"
import EventModel from "@/db/model/Event"
import PatientModel from "@/db/model/Patient"
import PatientAdditionalAttribute from "@/db/model/PatientAdditionalAttribute"
import { RegistrationFormField } from "@/db/model/PatientRegistrationForm"
import VisitModel from "@/db/model/Visit"
import { providerStore } from "@/store/provider"
import { toDateSafe } from "@/utils/date"

import Event from "./Event"
import PatientRegistrationForm from "./PatientRegistrationForm"
import UserClinicPermissions from "./UserClinicPermissions"
import Visit from "./Visit"
import { Logger } from "@hikmahealth/js-utils"

namespace Patient {
  export type T = {
    id: string
    givenName: string
    surname: string
    dateOfBirth: string
    citizenship: string
    hometown: string
    phone: string
    sex: string
    camp: string
    photoUrl: string
    governmentId: string
    externalPatientId: string
    additionalData: Record<string, any>
    metadata: Record<string, any>
    isDeleted: boolean
    deletedAt: Option.Option<Date>
    createdAt: Date
    updatedAt: Date

    // V5
    primaryClinicId?: string
    lastModifiedBy?: string
    // !v5
  }

  export type PatientValueColumn = "date_value" | "string_value" | "boolean_value" | "number_value"

  export type DBPatient = PatientModel
  export type DBPatientAttributes = PatientAdditionalAttribute

  export namespace AdditionalAttributes {
    export type T = {
      // TODO:
    }
  }

  /**
   * Display the patient name that would show in the avatar (usually in the case of no image)
   * @param {Patient} patient
   * @returns {string}
   */
  export const displayNameAvatar = (patient: Patient.T): string => {
    const { givenName = " ", surname = " " } = patient
    return getInitials(`${givenName} ${surname}`)
  }

  /**
   * Given a patients name, return the initials
   * @param {string} name
   * @param {number} maxLen
   * @returns {string}
   */
  export const getInitials = (name: string, maxLen = 3): string => {
    // split at the spaces and take the first letter of each word in the name, make it uppercase
    return name
      ?.split(" ")
      .map((word) => word?.[0]?.toUpperCase())
      .join("")
      .trim()
      .slice(0, maxLen)
  }

  /**
   * Display the patient name that would show in the patient list
   * @param {Patient} patient
   * @returns {string}
   */
  export const displayName = (patient: { givenName: string; surname: string }): string => {
    const { givenName = " ", surname = " " } = patient
    return `${givenName} ${surname}`.trim()
  }

  /**
  Given a PatientRegistrationForm.FormState, return the value of the field, or the default value
  @param {PatientRegistrationForm.PatientRecord} patientRecord
  @param {string} fieldName
  @param {T} fallback
  */
  export function getPatientFieldByName<T>(
    patientRecord: PatientRegistrationForm.PatientRecord,
    fieldName: string,
    fallback?: T,
  ): T | undefined {
    const { fields, values } = patientRecord
    // get the id of the field from the form
    const field = fields.find((field) => field.column === fieldName)
    if (!field) {
      return fallback || undefined
    }

    // get the value from the data field by the id
    return (values[field.id] as T) || fallback || undefined
  }

  /**
  Given a PatientRecord, return the value of the field by its ID, or the default value
  @param {PatientRegistrationForm.PatientRecord} patientRecord
  @param {string} fieldId
  @param {T} fallback
  */
  export function getPatientFieldById<T>(
    patientRecord: PatientRegistrationForm.PatientRecord,
    fieldId: string,
    fallback?: T,
  ): T | undefined {
    const { values } = patientRecord
    if (!fieldId) {
      return fallback ?? undefined
    }

    // get the value from the data field by the id
    return (values[fieldId] as T) ?? fallback ?? undefined
  }

  /**
  Given a the fields of a patient form, and the attributeID, return the
  column name of that field.

  Returns the default of "string_value" column name, including if there are any errors.
  @param {RegistrationFormField[]} fields
  @param {string} attributeId
  @returns {PatientValueColumn}
  */
  export function getAdditionalFieldColumnName(
    fields: RegistrationFormField[],
    attributeId: string,
  ): PatientValueColumn {
    const attr = fields.find((f) => f.id === attributeId)

    if (!attr) {
      Logger.warn({
        msg: "Attribute column name not found. Returning 'string_value' default. AttributeId: ",
        fields,
        attributeId,
      })
      return "string_value"
    }

    if (attr.fieldType === "number") {
      return "number_value"
    } else if (
      attr.fieldType === "select" ||
      attr.fieldType === "text" ||
      attr.fieldType === "checkbox"
    ) {
      return "string_value"
    } else if (attr.fieldType === "date") {
      return "date_value"
    } else if (attr.fieldType === "boolean") {
      return "boolean_value"
    }

    // if all else fails, somehow
    return "string_value"
  }

  /**
  A value that is absent or whitespace-only is never treated as a uniqueness
  collision — otherwise two patients both leaving an optional unique field
  blank would appear to duplicate each other.
  @param {unknown} value
  @returns {boolean}
  */
  export function isBlankUniqueValue(value: unknown): boolean {
    if (value === undefined || value === null) return true
    if (typeof value === "string" && value.trim() === "") return true
    return false
  }

  /**
  Coerce an in-memory value to the representation stored in a base `patients`
  column, so a uniqueness `Q.where` matches. All base columns are string
  columns; date fields (e.g. date_of_birth) are stored as "yyyy-MM-dd",
  mirroring `Patient.DB.register`.
  @param {RegistrationFormField} field
  @param {unknown} value
  @returns {string}
  */
  export function coerceBaseUniqueQueryValue(field: RegistrationFormField, value: unknown): string {
    if (field.fieldType === "date" && value instanceof Date) {
      return format(value, "yyyy-MM-dd")
    }
    // Base columns are @text, which trims on write; trim here too so the query
    // matches the stored value — otherwise a trailing space slips a duplicate
    // past the uniqueness check.
    return (typeof value === "string" ? value : String(value)).trim()
  }

  /**
  Coerce an in-memory value to the representation stored in a
  `patient_additional_attributes` value column, matching how
  `Patient.DB.register` / `updateById` write each type.
  @param {PatientValueColumn} valueColumn
  @param {unknown} value
  @returns {string | number | boolean}
  */
  export function coerceAttributeUniqueQueryValue(
    valueColumn: PatientValueColumn,
    value: unknown,
  ): string | number | boolean {
    switch (valueColumn) {
      case "number_value":
        return Number(value)
      case "boolean_value":
        return Boolean(value)
      case "date_value":
        return value instanceof Date ? value.getTime() : Number(value)
      case "string_value":
      default:
        // string_value is @text (trims on write); trim to match the stored value.
        return String(value || "").trim()
    }
  }

  /**
  Create the default patient record object given a patient registration form
  @param {RegistrationFormModel} registrationForm
  @returns {PatientRecord}
  */
  export function getDefaultPatientRecord(
    registrationForm: PatientRegistrationForm.PatientRecord,
  ): PatientRegistrationForm.PatientRecord {
    const values = registrationForm["fields"].reduce(
      (prev, field) => {
        const key = field.id
        if (["text", "select", "checkbox"].includes(field.fieldType)) {
          prev[key] = ""
        } else if (field.fieldType === "number") {
          prev[key] = 0
        } else if (field.fieldType === "date") {
          prev[key] = new Date()
        } else if (field.fieldType === "boolean") {
          prev[key] = false
        }
        return prev
      },
      {} as PatientRegistrationForm.PatientRecord["values"],
    )
    return {
      fields: registrationForm["fields"],
      values,
    }
  }

  export namespace DB {
    export type T = PatientModel
    export const table_name = "patients"

    /**
     * Subscription to a patient record in the database. Emits `null` when the patient is not
     * viewable — no such row on this device, or no history permission on its primary clinic.
     *
     * @param patientId The patient ID
     * @param provider The signed-in provider's id and clinic
     * @param callback Function called when patient data updates
     * @returns {{unsubscribe: () => void}} Object containing unsubscribe function
     */
    export function subscribe(
      patientId: string,
      provider: {
        userId: string
        clinicId: string
      },
      callback: (patient: DB.T | null, isLoading: boolean) => void,
    ): { unsubscribe: () => void } {
      const { userId, clinicId } = provider

      // No clinic means no permission context; throwing would take down the caller's screen.
      if (!clinicId) {
        Logger.warn({ msg: "Patient.DB.subscribe: provider belongs to no clinic", userId })
        callback(null, false)
        return { unsubscribe: () => {} }
      }

      let permissionsLoaded = false
      let viewHistoryClinicIds: string[] = []
      let latestPatient: DB.T | undefined

      function emitPatient(dbPatient: DB.T) {
        // Don't emit until permissions are loaded
        if (!permissionsLoaded) return
        // If the patient has no primary clinic, then just return the patient.
        if (
          !dbPatient.primaryClinicId ||
          viewHistoryClinicIds.includes(dbPatient.primaryClinicId)
        ) {
          callback(dbPatient, false)
        } else {
          callback(null, false)
        }
      }

      // A failed lookup degrades to "no history clinics" rather than pinning the caller on loading.
      UserClinicPermissions.DB.getClinicIdsWithPermission(userId, "canViewHistory")
        .then((ids) => {
          viewHistoryClinicIds = ids
        })
        .catch((error) => {
          Logger.error(error)
          Sentry.captureException(error)
        })
        .finally(() => {
          permissionsLoaded = true
          // Re-evaluate with the latest patient if we already have one
          if (latestPatient !== undefined) {
            emitPatient(latestPatient)
          }
        })

      const subscription = database.collections
        .get<DB.T>("patients")
        .findAndObserve(patientId)
        .pipe(
          // Absent on this device — deleted upstream or never synced; unpiped it crashes the app.
          catchError((error) => {
            Logger.error(error)
            return of$(null)
          }),
        )
        .subscribe((dbPatient) => {
          if (!dbPatient) {
            // Nothing for the permission lookup to re-evaluate, so `latestPatient` stays unset.
            callback(null, false)
            return
          }
          latestPatient = dbPatient
          emitPatient(dbPatient)
        })

      return {
        unsubscribe: () => subscription.unsubscribe(),
      }
    }

    /**
     * Fetch patient report data used in the generation of a downloadable report pdf
     * @param {string} patientId
     * @param {boolean} ignoreEmptyVisits
     * @returns {Promise<{ visit: Visit.DB.T, events: Event.DB.T[] }[]>}
     */
    export async function getReportData(
      patientId: string,
      ignoreEmptyVisits: boolean,
    ): Promise<{ visit: Visit.DB.T; events: Event.DB.T[] }[]> {
      const visits = await database
        .get<Visit.DB.T>("visits")
        .query(Q.and(Q.where("patient_id", patientId), Q.where("is_deleted", false)))
        .fetch()

      const events = await database
        .get<Event.DB.T>("events")
        .query(Q.and(Q.where("patient_id", patientId), Q.where("is_deleted", false)))
        .fetch()

      const results = visits.map((visit) => {
        return {
          visit,
          events: events.filter((ev) => ev.visitId === visit.id),
        }
      })
      if (ignoreEmptyVisits) {
        return results.filter((res) => res.events.length > 0)
      }
      return results
    }

    /**
     * Converts from PatientModel (aka DBPatient) to Patient.T
     * @param dbPatient The PatientModel to convert
     * @returns The converted Patient.T
     */
    export const fromDB = (dbPatient: DB.T): Patient.T => ({
      id: dbPatient.id,
      givenName: dbPatient.givenName,
      surname: dbPatient.surname,
      dateOfBirth: dbPatient.dateOfBirth,
      citizenship: dbPatient.citizenship,
      hometown: dbPatient.hometown,
      phone: dbPatient.phone,
      sex: dbPatient.sex,
      camp: dbPatient.camp,
      photoUrl: dbPatient.photoUrl,
      governmentId: dbPatient.governmentId,
      externalPatientId: dbPatient.externalPatientId,
      additionalData: dbPatient.additionalData,
      metadata: dbPatient.metadata,
      isDeleted: dbPatient.isDeleted,
      deletedAt: Option.fromNullable(dbPatient.deletedAt),
      createdAt: dbPatient.createdAt,
      updatedAt: dbPatient.updatedAt,
      primaryClinicId: dbPatient.primaryClinicId,
      lastModifiedBy: dbPatient.lastModifiedBy,
    })

    /** Default empty Patient Item */
    export const empty: Patient.T = {
      id: Math.random().toString(),
      givenName: "John",
      surname: "Doe",
      dateOfBirth: "1990-01-01",
      citizenship: "",
      hometown: "",
      phone: "",
      sex: "male",
      camp: "",
      photoUrl: "",
      governmentId: "",
      externalPatientId: "",
      additionalData: {},
      metadata: {},
      isDeleted: false,
      deletedAt: Option.none(),
      createdAt: new Date(),
      updatedAt: new Date(),
      primaryClinicId: "",
      lastModifiedBy: "",
    }

    /**
    Register a new patient
    @param {PatientRegistrationForm.PatientRecord} patientRecord
    @param {{ id: string; name: string }} provider - The provider information
    @param {{ id: string; name: string }} clinic - The clinic information
    @returns {Promise<PatientModel["id"]>}
    */
    export const register = async (
      patientRecord: PatientRegistrationForm.PatientRecord,
      provider: { id: string; name: string },
      clinic: { id: string; name: string },
    ): Promise<PatientModel["id"]> => {
      // Check permission before registering
      const primaryClinicId =
        getPatientFieldByName(patientRecord, "primary_clinic_id", "") || clinic.id
      const permission = "canRegisterPatients"
      const permissionClinicIds = await UserClinicPermissions.DB.getClinicIdsWithPermission(
        provider.id,
        permission,
      )
      const hasPermission = permissionClinicIds?.includes(primaryClinicId)
      if (!hasPermission) {
        throw new Error("Permission denied")
      }

      const { fields, values } = patientRecord

      // prepare the patient record
      const ptQuery = database.get<PatientModel>("patients").prepareCreate((newPatient) => {
        newPatient.givenName = getPatientFieldByName(patientRecord, "given_name", "") || ""
        newPatient.surname = getPatientFieldByName(patientRecord, "surname", "") || ""
        newPatient.sex = getPatientFieldByName(patientRecord, "sex", "") || ""
        newPatient.phone = getPatientFieldByName(patientRecord, "phone", "") || ""
        newPatient.citizenship = getPatientFieldByName(patientRecord, "citizenship", "") || ""
        newPatient.photoUrl = getPatientFieldByName(patientRecord, "photo_url", "") || ""
        newPatient.camp = getPatientFieldByName(patientRecord, "camp", "") || ""
        newPatient.hometown = getPatientFieldByName(patientRecord, "hometown", "") || ""
        // The form hands this over as either a "YYYY-MM-DD" string or a Date.
        // `format` resolves a string via `new Date(str)` — UTC midnight — then
        // prints it locally, losing a day west of UTC; toDateSafe does not.
        newPatient.dateOfBirth = format(
          toDateSafe(getPatientFieldByName(patientRecord, "date_of_birth", new Date()), new Date()),
          "yyyy-MM-dd",
        )
        newPatient.additionalData = getPatientFieldByName(
          patientRecord,
          "additional_data",
          {},
        ) as Record<any, any>
        newPatient.governmentId = getPatientFieldByName(patientRecord, "government_id", "") || ""
        newPatient.externalPatientId =
          getPatientFieldByName(patientRecord, "external_patient_id", "") || ""
        newPatient.primaryClinicId = primaryClinicId || ""
        newPatient.lastModifiedBy = provider.id
      })

      const patientAttributesRef = database.get<PatientAdditionalAttribute>(
        "patient_additional_attributes",
      )
      const attrQueries = fields
        .filter((field) => !field.baseField)
        .map((field) => {
          return patientAttributesRef.prepareCreate((newAttr) => {
            newAttr.patientId = ptQuery.id
            newAttr.attributeId = field.id
            newAttr.attribute = field.column

            newAttr.metadata = {}

            if (field.fieldType === "number") {
              newAttr.numberValue = values[field.id] as number
            } else if (field.fieldType === "date") {
              newAttr.dateValue = values[field.id] as number
            } else if (field.fieldType === "boolean") {
              newAttr.booleanValue = values[field.id] as boolean
            } else {
              newAttr.stringValue = String(values[field.id] || "")
            }
          })
        })

      // commit the db changes
      await database.write(async () => {
        return database.batch([ptQuery, ...attrQueries])
      })

      return ptQuery.id
    }

    /**
    Check whether a *different*, non-deleted patient already holds `value`
    for a field marked `unique`. Covers both storage mechanisms:
    base-column fields query the `patients` table; custom fields query
    `patient_additional_attributes` on the typed value column.

    Best-effort, local-DB only: it sees just the patients synced to this
    device (see the offline caveat in the unique-fields design). Errors
    fail open (return false) — matching the government_id check — so a
    transient query failure never blocks a legitimate save; the on-submit
    gate re-runs this check before writing.

    @param field the field being validated
    @param value the in-memory value for that field
    @param fields the full form field list (resolves the attribute value column)
    @param excludePatientId when editing, the patient being edited (excluded from the match)
    @returns {Promise<boolean>} true when a duplicate exists on another patient
    */
    export const checkUniqueFieldValue = async (args: {
      field: RegistrationFormField
      value: unknown
      fields: RegistrationFormField[]
      excludePatientId?: string
    }): Promise<boolean> => {
      const { field, value, fields, excludePatientId } = args

      // Empty / whitespace values never collide — two patients may both
      // leave an optional unique field blank.
      if (isBlankUniqueValue(value)) return false

      try {
        if (field.baseField) {
          const conditions = [
            Q.where(field.column, coerceBaseUniqueQueryValue(field, value)),
            Q.where("is_deleted", false),
          ]
          if (excludePatientId) conditions.push(Q.where("id", Q.notEq(excludePatientId)))

          const matches = await database
            .get<PatientModel>("patients")
            .query(...conditions)
            .fetch()
          return matches.length > 0
        }

        const valueColumn = getAdditionalFieldColumnName(fields, field.id)
        const attrConditions = [
          Q.where("attribute_id", field.id),
          Q.where(valueColumn, coerceAttributeUniqueQueryValue(valueColumn, value)),
          Q.where("is_deleted", false),
        ]
        if (excludePatientId) attrConditions.push(Q.where("patient_id", Q.notEq(excludePatientId)))

        const attrs = await database
          .get<PatientAdditionalAttribute>("patient_additional_attributes")
          .query(...attrConditions)
          .fetch()
        if (attrs.length === 0) return false

        // Attribute rows can outlive a soft-deleted patient, so confirm at
        // least one owning patient is itself still present.
        const ownerIds = Array.from(new Set(attrs.map((attr) => attr.patientId)))
        const livingOwners = await database
          .get<PatientModel>("patients")
          .query(Q.where("id", Q.oneOf(ownerIds)), Q.where("is_deleted", false))
          .fetch()
        return livingOwners.length > 0
      } catch (error) {
        Logger.error(error)
        return false
      }
    }

    /**
    Get patient by government_id
    @param {string} governmentId
    @param {RegistrationFormField[]} fields
    @returns {Promise<PatientRegistrationForm.PatientRecord>}
    */
    export const getByGovernmentId = async (
      governmentId: string,
      formFields: RegistrationFormField[],
    ): Promise<PatientRegistrationForm.PatientRecord> => {
      const patientRecord: PatientRegistrationForm.PatientRecord = {
        fields: formFields,
        values: {},
      }

      if (!governmentId || governmentId.length <= 3) {
        return Promise.reject("Unable to find patient with government_id: " + governmentId)
      }

      try {
        const patients = await database
          .get<PatientModel>("patients")
          .query(Q.where("government_id", governmentId))
          .fetch()

        if (patients.length === 0) {
          return Promise.reject("Unable to find patient with government_id: " + governmentId)
        }

        const patient = patients[0]
        if (patients.length > 1) {
          Logger.error("Multiple patients with the same government id have been recorded")
        }

        formFields
          .filter((field) => field.baseField)
          .map((bField) => {
            // patient column names are in came case while the db columns are in
            // snake_case. This is an artifact of using watermelondb.
            const columnName = camelCase(bField.column)
            const value = patient[columnName] as string | number | Date
            patientRecord["values"][bField.id] = value
          })

        const additionalFields = await database
          .get<PatientAdditionalAttribute>("patient_additional_attributes")
          .query(Q.where("government_id", governmentId), Q.sortBy("updated_at", "asc"))
          .fetch()

        // TODO: abstract out
        const values = additionalFields.reduce(
          (prev, field) => {
            const key = field.attributeId
            if (key in prev) {
              Logger.warn(
                "Additional patient field duplicate detected. Overwiting with newer record",
              )
            }
            const additionalFieldName = getAdditionalFieldColumnName(formFields, key)
            if (additionalFieldName === "string_value") {
              prev[key] = field.stringValue
            } else if (additionalFieldName === "date_value") {
              prev[key] = field.dateValue
            } else if (additionalFieldName === "number_value") {
              prev[key] = field.numberValue
            } else if (additionalFieldName === "boolean_value") {
              prev[key] = field.booleanValue
            }
            return prev
          },
          {} as PatientRegistrationForm.PatientRecord["values"],
        )

        patientRecord.values = {
          ...patientRecord.values,
          ...values,
        }
        return patientRecord
      } catch (error) {
        Logger.error({ msg: "Error getting the patient by govoernment id: ", error })
        return Promise.reject(error)
      }
    }

    /**
    Get patient by id
    @param {string} id
    @param {RegistrationFormField[]} fields
    @returns {Promise<PatientRegistrationForm.PatientRecord>}
    */
    export const getById = async (
      id: string,
      formFields: RegistrationFormField[],
    ): Promise<PatientRegistrationForm.PatientRecord> => {
      const patientRecord: PatientRegistrationForm.PatientRecord = {
        fields: formFields,
        values: {},
      }

      try {
        const patient = await database.get<PatientModel>("patients").find(id)

        formFields
          .filter((field) => field.baseField)
          .map((bField) => {
            // patient column names are in came case while the db columns are in
            // snake_case. This is an artifact of using watermelondb.
            const columnName = camelCase(bField.column)
            const value = patient[columnName] as string | number | Date
            patientRecord["values"][bField.id] = value
          })

        const additionalFields = await database
          .get<PatientAdditionalAttribute>("patient_additional_attributes")
          .query(Q.where("patient_id", id), Q.sortBy("updated_at", "asc"))
          .fetch()

        // TODO: abstract out
        const values = additionalFields.reduce(
          (prev, field) => {
            const key = field.attributeId
            if (key in prev) {
              Logger.warn(
                "Additional patient field duplicate detected. Overwiting with newer record",
              )
            }
            const additionalFieldName = getAdditionalFieldColumnName(formFields, key)
            if (additionalFieldName === "string_value") {
              prev[key] = field.stringValue
            } else if (additionalFieldName === "date_value") {
              prev[key] = field.dateValue
            } else if (additionalFieldName === "number_value") {
              prev[key] = field.numberValue
            } else if (additionalFieldName === "boolean_value") {
              prev[key] = field.booleanValue
            }
            return prev
          },
          {} as PatientRegistrationForm.PatientRecord["values"],
        )

        patientRecord.values = {
          ...patientRecord.values,
          ...values,
        }
      } catch (error) {
        Logger.error({ msg: "Error getting the patient by id: ", error })
      } finally {
        return patientRecord
      }
    }

    /**
    Update a patient by id
    @param patientId {string}
    @param patientRecord {PatientRegistrationForm.PatientRecord}
    */
    export const updateById = async (
      patientId: string,
      patientRecord: PatientRegistrationForm.PatientRecord,
      provider: { id: string; name: string },
      clinic: { id: string; name: string },
    ) => {
      const { fields, values } = patientRecord
      const primaryClinicId =
        getPatientFieldByName(patientRecord, "primary_clinic_id", "") || clinic.id
      const viewHistoryClinicIds = await UserClinicPermissions.DB.getClinicIdsWithPermission(
        provider.id,
        "canEditRecords",
      )

      if (!viewHistoryClinicIds.includes(primaryClinicId)) {
        throw new Error("Unauthorized")
      }

      // prepare the patient record

      const patient = await database.get<PatientModel>("patients").find(patientId)
      const patientDateOfBirth = getPatientFieldByName(patientRecord, "date_of_birth", "") || ""
      const ptQuery = patient.prepareUpdate((updPatient) => {
        updPatient.givenName = getPatientFieldByName(patientRecord, "given_name", "") || ""
        updPatient.surname = getPatientFieldByName(patientRecord, "surname", "") || ""
        updPatient.sex = getPatientFieldByName(patientRecord, "sex", "") || ""
        updPatient.phone = getPatientFieldByName(patientRecord, "phone", "") || ""
        updPatient.citizenship = getPatientFieldByName(patientRecord, "citizenship", "") || ""
        updPatient.photoUrl = getPatientFieldByName(patientRecord, "photo_url", "") || ""
        updPatient.camp = getPatientFieldByName(patientRecord, "camp", "") || ""
        updPatient.hometown = getPatientFieldByName(patientRecord, "hometown", "") || ""
        updPatient.dateOfBirth = isValid(new Date(patientDateOfBirth)) ? patientDateOfBirth : ""
        updPatient.additionalData = getPatientFieldByName(
          patientRecord,
          "additional_data",
          {},
        ) as Record<any, any>
        updPatient.governmentId = getPatientFieldByName(patientRecord, "government_id", "") || ""
        updPatient.externalPatientId =
          getPatientFieldByName(patientRecord, "external_patient_id", "") || ""

        updPatient.primaryClinicId = primaryClinicId || ""
        updPatient.lastModifiedBy = provider.id || ""
      })

      const patientAttributesRef = database.get<PatientAdditionalAttribute>(
        "patient_additional_attributes",
      )

      // Logger.log({"Update: ", patientId, values})

      const attrQueries = fields
        // filter out base columns
        .filter((field) => !field.baseField)
        .flatMap(async (field) => {
          try {
            const attrs = await patientAttributesRef
              .query(Q.where("patient_id", patientId), Q.where("attribute_id", field.id))
              .fetch()

            if (attrs.length === 0) {
              // This is a new attribute, should create it
              const newAttr = patientAttributesRef.prepareCreate((ptAttr) => {
                ptAttr.patientId = ptQuery.id
                ptAttr.attributeId = field.id
                ptAttr.attribute = field.column
                ptAttr.metadata = {}
                if (field.fieldType === "number") {
                  ptAttr.numberValue = values[field.id] as number
                } else if (field.fieldType === "date") {
                  ptAttr.dateValue = values[field.id] as number
                } else if (field.fieldType === "boolean") {
                  ptAttr.booleanValue = values[field.id] as boolean
                } else {
                  ptAttr.stringValue = String(values[field.id] || "")
                }
              })
              return [newAttr]
            }
            return attrs.flatMap((attr) => {
              return attr.prepareUpdate((updAttr) => {
                updAttr.patientId = ptQuery.id
                updAttr.attributeId = field.id
                updAttr.attribute = field.column

                updAttr.metadata = {}

                if (field.fieldType === "number") {
                  updAttr.numberValue = values[field.id] as number
                } else if (field.fieldType === "date") {
                  updAttr.dateValue = values[field.id] as number
                } else if (field.fieldType === "boolean") {
                  updAttr.booleanValue = values[field.id] as boolean
                } else {
                  updAttr.stringValue = String(values[field.id] || "")
                }
              })
            })
          } catch (error) {
            Sentry.captureException(error)
            Logger.error(error)
            return []
          }
        })

      /** only update the attributes that resolved */
      const resolvedAttrQueries = await Promise.all(attrQueries)

      // commit the db changes
      return await database.write(async () => {
        return database.batch([ptQuery, ...resolvedAttrQueries.flat()])
      })
    }

    /**
    Delete a patient by id
    FIXME: Do all mark as deleted methods first set the "isDeleted" flag to true and set a deletedAt? or is that done at the server level?
    */
    export const deleteById = async (id: string) => {
      const patientRef = (
        await database.get<PatientModel>("patients").find(id)
      ).prepareMarkAsDeleted()

      const attrRef = (
        await database
          .get<PatientAdditionalAttribute>("patient_additional_attributes")
          .query(Q.where("patient_id", id))
          .fetch()
      ).map((attr) => {
        return attr.prepareMarkAsDeleted()
      })

      const appointmentsRef = (
        await database
          .get<AppointmentModel>("appointments")
          .query(Q.where("patient_id", id))
          .fetch()
      ).map((appointment) => appointment.prepareMarkAsDeleted())

      const visitsRef = (
        await database.get<VisitModel>("visits").query(Q.where("patient_id", id)).fetch()
      ).map((visit) => visit.prepareMarkAsDeleted())

      const eventsRef = (
        await database.get<EventModel>("events").query(Q.where("patient_id", id)).fetch()
      ).map((event) => event.prepareMarkAsDeleted())

      return database.write(async () => {
        return database.batch([
          patientRef,
          ...attrRef,
          ...appointmentsRef,
          ...visitsRef,
          ...eventsRef,
        ])
      })
    }
  }
}

export default Patient
