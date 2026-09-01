import { type Kysely, sql } from "kysely";

/**
 * Migration: create_patient_risk_profile_table
 * Created at: 2026-08-30
 * Description: Creates the patient_risk_profile_attributes table.
 *              A unique constraint on (patient_id, clinic_id, profile_key)
 *              ensures only one attribute value exists per patient, per clinic,
 *              per key — providing the record-level uniqueness identifier called
 *              for in the spec.
 */

export async function up(db: Kysely<any>): Promise<void> {
  // Create the enum type for profile value types
  await sql`
    CREATE TYPE profile_value_type AS ENUM (
      'string',
      'numeric',
      'integer',
      'boolean',
      'datetime'
    )
  `.execute(db);

  await db.schema
    .createTable("patient_risk_profile_attributes")
    .addColumn("id", "uuid", (col) => col.primaryKey().notNull())
    .addColumn("patient_id", "uuid", (col) => col.notNull())
    .addColumn("clinic_id", "uuid", (col) =>
      col.references("clinics.id").onDelete("cascade"),
    ) // null means not tied to a specific clinic
    .addColumn("profile_key", "text", (col) => col.notNull())
    .addColumn("unique_reference", "text")
    .addColumn("profile_value_type", sql`profile_value_type`, (col) =>
      col.notNull(),
    )
    .addColumn("string_value", "text")
    .addColumn("boolean_value", "boolean")
    .addColumn("integer_value", "integer")
    .addColumn("numerical_value", "decimal(31, 10)")
    .addColumn("datetime_value", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("last_modified", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("server_created_at", "timestamptz", (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .addColumn("deleted_at", "timestamptz")
    .addColumn("is_deleted", "boolean", (col) => col.notNull().defaultTo(false))
    .addForeignKeyConstraint(
      "patient_risk_attribute_fk",
      ["patient_id"],
      "patients",
      ["id"],
      (fk) => fk.onDelete("no action").onUpdate("cascade"),
    )
    .execute();

  await db.schema
    .createIndex("patient_unique_risk_attribute_idx")
    .unique()
    .on("patient_risk_profile_attributes")
    .columns(["patient_id", "profile_key", "unique_reference"])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("patient_unique_risk_attribute_idx").execute();
  await db.schema.dropTable("patient_risk_profile_attributes").execute();
  await sql`DROP TYPE profile_value_type`.execute(db);
}
