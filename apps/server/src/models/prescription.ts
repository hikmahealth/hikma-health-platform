import { addDays } from "date-fns";
import { Option } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  type JSONColumnType,
  sql,
} from "kysely";
import { Schema } from "effect";
import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import User from "./user";
import { isValidUUID, safeJSONParse, toSafeDateString } from "@/lib/utils";
import { v1 as uuidV1 } from "uuid";
import Visit from "./visit";
import type { PrescriptionItemValues } from "@/components/prescription-form";
import PrescriptionItem from "./prescription-items";
import type { RequestCaller } from "@/types";
import { match, P } from "ts-pattern";
import { Option as HHOption } from "@/lib/option";
import Device from "./device";
import { Logger } from "@hikmahealth/js-utils";

namespace Prescription {
  export const PrioritySchema = Schema.Union(
    Schema.Literal("high"),
    Schema.Literal("low"),
    Schema.Literal("normal"),
    Schema.Literal("emergency"),
  );

  export const priorityValues = ["high", "low", "normal", "emergency"] as const;

  export const StatusSchema = Schema.Union(
    Schema.Literal("pending"),
    Schema.Literal("prepared"),
    Schema.Literal("picked-up"),
    Schema.Literal("not-picked-up"),
    Schema.Literal("partially-picked-up"),
    Schema.Literal("cancelled"),
    Schema.Literal("other"),
  );
  export const statusValues = [
    "pending",
    "prepared",
    "picked-up",
    "not-picked-up",
    "partially-picked-up",
    "cancelled",
    "other",
  ] as const;

  /**
   * How many prescriptions carry one status. `status` is typed loosely because
   * it comes straight out of a GROUP BY, and the column is a plain string that
   * predates `StatusSchema` — rows outside the union are possible.
   */
  export type StatusCount = { status: string | null; count: number };

  export const PrescriptionSchema = Schema.Struct({
    id: Schema.String,
    patient_id: Schema.String,
    provider_id: Schema.String,
    filled_by: Schema.OptionFromNullOr(Schema.String),
    pickup_clinic_id: Schema.String,
    visit_id: Schema.OptionFromNullOr(Schema.String),
    priority: PrioritySchema,
    expiration_date: Schema.OptionFromNullOr(Schema.DateFromSelf),
    prescribed_at: Schema.DateFromSelf,
    filled_at: Schema.OptionFromNullOr(Schema.DateFromSelf),
    status: StatusSchema,
    items: Schema.Array(Schema.Unknown),
    notes: Schema.String,
    metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    is_deleted: Schema.Boolean,
    created_at: Schema.DateFromSelf,
    updated_at: Schema.DateFromSelf,
    deleted_at: Schema.OptionFromNullOr(Schema.DateFromSelf),
    last_modified: Schema.DateFromSelf,
    server_created_at: Schema.DateFromSelf,
  });

  export type T = typeof PrescriptionSchema.Type;
  export type EncodedT = typeof PrescriptionSchema.Encoded;

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = false;
    export const name = "prescriptions";
    export const mobileName = "prescriptions";

    export const columns = {
      id: "id",
      patient_id: "patient_id",
      provider_id: "provider_id",
      filled_by: "filled_by",
      pickup_clinic_id: "pickup_clinic_id",
      visit_id: "visit_id",
      priority: "priority",
      expiration_date: "expiration_date",
      prescribed_at: "prescribed_at",
      filled_at: "filled_at",
      status: "status",
      items: "items",
      notes: "notes",
      metadata: "metadata",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      deleted_at: "deleted_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
    };

    export interface T {
      id: string;
      patient_id: string;
      provider_id: string;
      filled_by: string | null;
      pickup_clinic_id: string;
      visit_id: string | null;
      priority: string | null;
      expiration_date: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      prescribed_at: Generated<ColumnType<Date, string | undefined, never>>;
      filled_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      status: Generated<string>;
      items: JSONColumnType<Array<unknown>>;
      notes: Generated<string>;
      metadata: JSONColumnType<Record<string, unknown>>;
      is_deleted: Generated<boolean>;
      created_at: Generated<ColumnType<Date, string | undefined, never>>;
      updated_at: Generated<
        ColumnType<Date, string | undefined, string | undefined>
      >;
      deleted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      last_modified: Generated<ColumnType<Date, string | undefined, never>>;
      server_created_at: Generated<ColumnType<Date, string | undefined, never>>;
    }

    export type Prescriptions = Selectable<T>;
    export type NewPrescriptions = Insertable<T>;
    export type PrescriptionsUpdate = Updateable<T>;
  }

  /**
   * Validity window when a prescription is saved without an expiry. Mirrors the
   * mobile default; the two models are separate, so it is stated in both.
   */
  const DEFAULT_VALIDITY_DAYS = 90;

  /**
   * The expiry to store for a prescription, as an ISO string. The web form
   * leaves it optional; an absent one falls back to `DEFAULT_VALIDITY_DAYS`
   * after the prescribing moment, matching what mobile writes.
   */
  export function resolveExpirationDate(
    expirationDate: unknown,
    prescribedAt: unknown,
  ): string {
    if (expirationDate) return toSafeDateString(expirationDate);

    return addDays(
      new Date(toSafeDateString(prescribedAt)),
      DEFAULT_VALIDITY_DAYS,
    ).toISOString();
  }

  export namespace API {
    /** One page of prescriptions across every patient, most recent first. */
    export const getPage = createServerOnlyFn(
      async (options: {
        limit: number;
        offset: number;
      }): Promise<{
        items: Prescription.EncodedT[];
        pagination: {
          offset: number;
          limit: number;
          total: number;
          hasMore: boolean;
        };
      }> => {
        const { limit, offset } = options;

        // `updated_at` moves when a status is toggled from this very list, so
        // ordering on it would shuffle rows between pages. `id` makes it total.
        const [items, countRow] = await Promise.all([
          db
            .selectFrom(Prescription.Table.name)
            .where("is_deleted", "=", false)
            .selectAll()
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .limit(limit)
            .offset(offset)
            .execute(),
          db
            .selectFrom(Prescription.Table.name)
            .select(db.fn.countAll().as("count"))
            .where("is_deleted", "=", false)
            .executeTakeFirst(),
        ]);

        const total = Number(countRow?.count ?? 0);

        return {
          items: items as unknown as Prescription.EncodedT[],
          pagination: {
            offset,
            limit,
            total,
            hasMore: offset + items.length < total,
          },
        };
      },
    );

    /** Paginated prescriptions for a patient, most recent first. */
    export const getByPatientId = createServerOnlyFn(
      async (options: {
        patientId: string;
        limit?: number;
        offset?: number;
        includeCount?: boolean;
      }): Promise<{
        items: Prescription.EncodedT[];
        statusCounts: StatusCount[];
        pagination: {
          offset: number;
          limit: number;
          total: number;
          hasMore: boolean;
        };
      }> => {
        const {
          patientId,
          limit = 10,
          offset = 0,
          includeCount = false,
        } = options;

        const items = await db
          .selectFrom(Table.name)
          .selectAll()
          .where("patient_id", "=", patientId)
          .where("is_deleted", "=", false)
          .orderBy("created_at", "desc")
          // Prescriptions from one visit share a `created_at`; without the
          // tiebreak those rows can repeat or vanish across pages.
          .orderBy("id", "desc")
          .limit(limit)
          .offset(offset)
          .execute();

        // One GROUP BY where a COUNT(*) used to be: the total is the sum of the
        // buckets, so the summary can never disagree with the page count. The
        // predicates must stay identical to the page query above for that to hold.
        let statusCounts: StatusCount[] = [];
        if (includeCount) {
          const rows = await db
            .selectFrom(Table.name)
            .select(["status"])
            .select(db.fn.countAll().as("count"))
            .where("patient_id", "=", patientId)
            .where("is_deleted", "=", false)
            .groupBy("status")
            .execute();
          statusCounts = rows.map((row) => ({
            status: row.status,
            count: Number(row.count ?? 0),
          }));
        }
        const total = statusCounts.reduce((sum, entry) => sum + entry.count, 0);

        return {
          items: items as unknown as Prescription.EncodedT[],
          statusCounts,
          pagination: {
            offset,
            limit,
            total,
            hasMore: items.length >= limit,
          },
        };
      },
    );

    export const toggleStatus = createServerOnlyFn(
      async (id: string, status: string) => {
        await db
          .updateTable(Prescription.Table.name)
          .set({
            status,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
          })
          .where("id", "=", id)
          .execute();
      },
    );

    /** Upsert a prescription. */
    export const save = createServerOnlyFn(
      async (
        id: string | null,
        prescription: Prescription.EncodedT,
        prescription_items: PrescriptionItemValues[], // TODO: replace this with the above. HACK: this is temporary
        currentUserName: string,
        currentClinicId: string,
      ) => {
        try {
          return await db.transaction().execute(async (trx) => {
            // Resolve clinic_id for visit creation:
            // 1. Use currentClinicId if valid
            // 2. Look up clinic_id from the existing visit
            // 3. Fall back to provider's clinic_id
            let resolvedClinicId = currentClinicId;
            if (!resolvedClinicId || !isValidUUID(resolvedClinicId)) {
              if (prescription.visit_id && isValidUUID(prescription.visit_id)) {
                const existingVisit = await trx
                  .selectFrom(Visit.Table.name)
                  .select("clinic_id")
                  .where("id", "=", prescription.visit_id)
                  .executeTakeFirst();
                if (existingVisit?.clinic_id) {
                  resolvedClinicId = existingVisit.clinic_id;
                }
              }

              if (!resolvedClinicId || !isValidUUID(resolvedClinicId)) {
                const provider = await trx
                  .selectFrom(User.Table.name)
                  .select("clinic_id")
                  .where("id", "=", prescription.provider_id)
                  .executeTakeFirstOrThrow();
                if (!provider.clinic_id) {
                  throw new Error(
                    "Provider has no clinic_id and no clinic_id was provided",
                  );
                }
                resolvedClinicId = provider.clinic_id;
              }
            }

            let visitId =
              prescription.visit_id && isValidUUID(prescription.visit_id)
                ? prescription.visit_id
                : null;

            if (!visitId) {
              let newVisitId = uuidV1();
              const visit = await trx
                .insertInto(Visit.Table.name)
                .values({
                  id: newVisitId,
                  patient_id: prescription.patient_id,
                  clinic_id: resolvedClinicId,
                  provider_id: prescription.provider_id, // the user_id is that of the current user, to a visit that is the provider
                  is_deleted: false,
                  created_at: sql`now()::timestamp with time zone`,
                  updated_at: sql`now()::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                  server_created_at: sql`now()::timestamp with time zone`,
                  deleted_at: null,
                  metadata: {} as any,
                  provider_name: currentUserName,
                })
                .returningAll()
                .executeTakeFirstOrThrow();

              visitId = newVisitId;
            }

            // If there is no pickup_clinic_id, set it to the current clinic_id or the clinic_id that the provider works for
            let pickupClinicId = prescription.pickup_clinic_id;
            if (!pickupClinicId || !isValidUUID(pickupClinicId)) {
              const provider = await trx
                .selectFrom(User.Table.name)
                .select("clinic_id")
                .where("id", "=", prescription.provider_id)
                .executeTakeFirstOrThrow();
              if (!provider.clinic_id) {
                throw new Error(
                  "Provider has no clinic_id, and appointment has no pickup_clinic_id",
                );
              }
              pickupClinicId = provider.clinic_id;
            }

            const prescriptionId = id || prescription.id || uuidV1();

            const res = await trx
              .insertInto(Prescription.Table.name)
              .values({
                id: prescriptionId,
                patient_id: prescription.patient_id,
                provider_id: prescription.provider_id,
                pickup_clinic_id: pickupClinicId,
                filled_by: prescription.filled_by || null,
                visit_id: visitId,
                priority: prescription.priority,
                expiration_date: sql`${resolveExpirationDate(
                  prescription.expiration_date,
                  prescription.prescribed_at,
                )}::timestamp with time zone`,
                prescribed_at: sql`${toSafeDateString(
                  prescription.prescribed_at,
                )}::timestamp with time zone`,
                filled_at: prescription.filled_at
                  ? sql`${toSafeDateString(
                      prescription.filled_at,
                    )}::timestamp with time zone`
                  : null,
                status: prescription.status,
                // items is superseded by the prescription_items table
                items: sql`${JSON.stringify([])}::jsonb`,
                notes: prescription.notes || "",
                metadata: {} as any,
                is_deleted: false,
                created_at: sql`${toSafeDateString(
                  prescription.created_at,
                )}::timestamp with time zone`,
                updated_at: sql`${toSafeDateString(
                  prescription.updated_at,
                )}::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
                server_created_at: sql`now()::timestamp with time zone`,
                deleted_at: null,
              })
              .onConflict((oc) => {
                return (
                  oc
                    .column("id")
                    .doUpdateSet({
                      patient_id: (eb) => eb.ref("excluded.patient_id"),
                      provider_id: (eb) => eb.ref("excluded.provider_id"),
                      pickup_clinic_id: (eb) =>
                        eb.ref("excluded.pickup_clinic_id"),
                      filled_by: (eb) => eb.ref("excluded.filled_by"),
                      visit_id: (eb) => eb.ref("excluded.visit_id"),
                      priority: (eb) => eb.ref("excluded.priority"),
                      expiration_date: (eb) =>
                        eb.ref("excluded.expiration_date"),
                      status: (eb) => eb.ref("excluded.status"),
                      items: (eb) => eb.ref("excluded.items"),
                      notes: (eb) => eb.ref("excluded.notes"),
                      metadata: (eb) => eb.ref("excluded.metadata"),
                      updated_at: sql`${toSafeDateString(
                        prescription.updated_at,
                      )}::timestamp with time zone`,
                      last_modified: sql`now()::timestamp with time zone`,
                    })
                    // Only update if the incoming record is newer than what's already stored
                    .where(
                      sql<boolean>`excluded.updated_at > prescriptions.updated_at`,
                    )
                );
              })
              .executeTakeFirst();

            if (!res) {
              // Stale record skipped by the updated_at guard — don't upsert items either
              Logger.info(
                `[sync] Skipped stale upsert for prescription ${prescriptionId}`,
              );
              return { numInsertedOrUpdatedRows: BigInt(0) };
            }

            if (prescription_items.length > 0) {
              const itemsRes = await trx
                .insertInto(PrescriptionItem.Table.name)
                .values(
                  prescription_items.map((item) => ({
                    clinic_id: pickupClinicId,
                    dosage_instructions: item.dosage_instructions,
                    drug_id: item.drug_id,
                    id: item.id || uuidV1(),
                    patient_id: prescription.patient_id,
                    prescription_id: prescriptionId,
                    quantity_prescribed: item.quantity_prescribed,
                    item_status: item.item_status,
                    notes: item.notes,
                    quantity_dispensed: item.quantity_dispensed,
                    refills_authorized: item.refills_authorized,
                    refills_used: item.refills_used,
                  })),
                )
                .executeTakeFirstOrThrow();
            }

            return res;
          });
        } catch (error) {
          Logger.error({
            msg: "Prescription save operation failed:",
            error: {
              operation: "prescription_save",
              error: {
                message: error instanceof Error ? error.message : String(error),
                name:
                  error instanceof Error ? error.constructor.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
              },
              context: {
                prescriptionId: id || prescription.id,
                patientId: prescription.patient_id,
                providerId: prescription.provider_id,
                clinicId: currentClinicId,
                hasValidVisitId: !!(
                  prescription.visit_id && isValidUUID(prescription.visit_id)
                ),
              },
              timestamp: new Date().toISOString(),
            },
          });
          throw error;
        }
      },
    );

    /** Soft delete a prescription. */
    export const softDelete = createServerOnlyFn(async (id: string) => {
      await db
        .updateTable(Prescription.Table.name)
        .set({
          is_deleted: true,
          deleted_at: sql`now()::timestamp with time zone`,
          updated_at: sql`now()::timestamp with time zone`,
          last_modified: sql`now()::timestamp with time zone`,
        })
        .where("id", "=", id)
        .execute();
    });
  }

  export namespace Sync {
    export const upsertFromDelta = createServerOnlyFn(
      async (delta: Prescription.EncodedT, caller: RequestCaller) => {
        const { userId, clinicId } = match(caller)
          .with({ device: P.select() }, (_) => ({ userId: "", clinicId: "" }))
          .with({ user: P.select() }, (user) => ({
            userId: user.id,
            clinicId: user.clinic_id,
          }))
          .exhaustive();

        return API.save(
          delta.id || uuidV1(),
          delta,
          [],
          userId || "",
          clinicId || "",
        );
      },
    );

    export const deleteFromDelta = createServerOnlyFn(async (id: string) => {
      return API.softDelete(id);
    });
  }
}

export default Prescription;
