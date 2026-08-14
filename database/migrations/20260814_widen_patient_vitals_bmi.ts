import { Kysely, sql } from "kysely";

/**
 * Migration: widen_patient_vitals_bmi
 * Created at: 2026-08-14
 * Description: Widen patient_vitals.bmi from numeric(4,2) to numeric(6,2).
 *
 *   numeric(4,2) caps at 99.99. BMI above 100 is clinically real at the
 *   extremes, and the vitals form validates height (50-250cm) and weight
 *   (1-300kg) independently, so a plausible-looking pair yields values up to
 *   ~1200. Every such record failed the ENTIRE sync push with 22003 "numeric
 *   field overflow", wedging the device on the same poison record. 6,2 covers
 *   the whole validated envelope, so nothing needs clamping.
 *
 *   NOTE: temperature_celsius is deliberately left at numeric(4,2). A celsius
 *   reading cannot legitimately exceed 99.99, and that narrowness is what
 *   catches a Fahrenheit value stored without conversion.
 * Depends on: 20260811_add_clinic_ids_to_app_config
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE patient_vitals
    ALTER COLUMN bmi TYPE numeric(6, 2)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Narrowing back fails if any row now holds a value the old type cannot
  // represent. Those rows are exactly the ones this migration exists to admit,
  // so clear them rather than let the rollback wedge.
  await sql`
    UPDATE patient_vitals
    SET bmi = NULL
    WHERE bmi IS NOT NULL AND ABS(bmi) >= 100
  `.execute(db);

  await sql`
    ALTER TABLE patient_vitals
    ALTER COLUMN bmi TYPE numeric(4, 2)
  `.execute(db);
}
