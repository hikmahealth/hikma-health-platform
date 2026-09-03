import { Model } from "@nozbe/watermelondb"
import { field, text, date, readonly, relation } from "@nozbe/watermelondb/decorators"

import Patient from "./Patient"

type ProfileValueType = "string" | "numeric" | "integer" | "boolean" | "datetime" | "json"

export default class PatientRiskProfile extends Model {
  static table = "patient_risk_profiles"

  static associations = {
    patients: { type: "belongs_to" as const, key: "patient_id" },
  }

  // --- Identity ---
  @text("patient_id") patientId!: string
  @text("clinic_id") clinicId?: string
  @text("kind") kind!: string
  @text("source") source!: string
  @text("target") target?: string
  @text("version") version!: string

  // --- Value type discriminator ---
  // One of: 'string' | 'numeric' | 'integer' | 'boolean' | 'datetime' | 'json'
  @text("value_type") valueType!: ProfileValueType

  // --- Value columns (only the one matching valueType is populated) ---
  @text("string_value") stringValue?: string
  @field("boolean_value") booleanValue?: boolean
  @field("integer_value") integerValue?: number
  // Stored as string to preserve decimal(31,10) precision without float loss
  @text("numerical_value") numericalValue?: string
  @date("datetime_value") datetimeValue?: Date
  // Stored as JSON string
  @text("json_value") jsonValue?: string
  @text("metadata") metadata?: string

  // --- Flags ---
  @field("is_deleted") isDeleted!: boolean

  // --- Timestamps (read-only) ---
  @readonly @date("created_at") createdAt!: Date
  @readonly @date("updated_at") updatedAt!: Date
  @date("last_modified") lastModified!: Date
  @date("server_created_at") serverCreatedAt!: Date
  @date("deleted_at") deletedAt?: Date

  // --- Relations ---
  @relation("patients", "patient_id") patient!: Patient
}
