import { Kysely } from "kysely";

/**
 *  purpose to include a column that can be used to identify uniqueness of a record for a given patient.
 */

export async function up(db: Kysely<any>) {
  await db.schema
    .alterTable("patient_additional_attributes")
    .addColumn("unique_reference", "varchar")
    .execute();

  await db.schema
    .createIndex("unique_patient_attribute_idx")
    .on("patient_additional_attributes")
    .columns(["patient_id", "unique_reference", "attribute"])
    .execute();
}

export async function down(db: Kysely<any>) {
  await db.schema.dropIndex("unique_patient_attribute_idx").execute();
  await db.schema
    .alterTable("patient_additional_attributes")
    .dropColumn("unique_reference")
    .execute();
}
