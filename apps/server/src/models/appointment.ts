import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import { Either, Option, Schema } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  type JSONColumnType,
  sql,
} from "kysely";
import Visit from "./visit";
import { v1 as uuidV1 } from "uuid";
import {
  isValidUUID,
  safeJSONParse,
  safeStringify,
  toSafeDateString,
} from "@/lib/utils";
import Patient from "./patient";
import User from "./user";
import Clinic from "./clinic";
import type { RequestCaller } from "@/types";
import { match, P } from "ts-pattern";
import { uuidv7 } from "uuidv7";
import { Logger } from "@hikmahealth/js-utils";

namespace Appointment {
  export const StatusSchema = Schema.Union(
    Schema.Literal("pending"),
    Schema.Literal("confirmed"),
    Schema.Literal("cancelled"),
    Schema.Literal("completed"),
    Schema.Literal("checked_in"),
  );

  export const DepartmentStatusSchema = Schema.Union(
    Schema.Literal("pending"),
    Schema.Literal("in_progress"),
    Schema.Literal("completed"),
    Schema.Literal("cancelled"),
    Schema.Literal("checked_in"),
  );

  export const DepartmentSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    seen_at: Schema.OptionFromNullOr(Schema.String),
    seen_by: Schema.OptionFromNullOr(Schema.String),
    status: DepartmentStatusSchema,
  });

  export const AppointmentSchema = Schema.Struct({
    id: Schema.String,
    provider_id: Schema.OptionFromNullOr(Schema.String),
    clinic_id: Schema.String,
    patient_id: Schema.String,
    user_id: Schema.String,
    current_visit_id: Schema.String,
    fulfilled_visit_id: Schema.OptionFromNullOr(Schema.String),
    timestamp: Schema.DateFromSelf,
    duration: Schema.Number,
    reason: Schema.String,
    notes: Schema.String,
    status: StatusSchema,
    departments: Schema.Array(DepartmentSchema),
    is_walk_in: Schema.Boolean,
    metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    is_deleted: Schema.Boolean,
    created_at: Schema.DateFromSelf,
    updated_at: Schema.DateFromSelf,
    last_modified: Schema.DateFromSelf,
    server_created_at: Schema.DateFromSelf,
    deleted_at: Schema.OptionFromNullOr(Schema.DateFromSelf),
  });
  export type T = typeof AppointmentSchema.Type;
  export type EncodedT = typeof AppointmentSchema.Encoded;

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = false;
    export const name = "appointments";

    /** The name of the table in the mobile database */
    export const mobileName = "appointments";

    export const columns = {
      id: "id",
      provider_id: "provider_id",
      clinic_id: "clinic_id",
      patient_id: "patient_id",
      user_id: "user_id",
      current_visit_id: "current_visit_id",
      fulfilled_visit_id: "fulfilled_visit_id",
      timestamp: "timestamp",
      duration: "duration",
      reason: "reason",
      notes: "notes",
      status: "status",
      departments: "departments",
      is_walk_in: "is_walk_in",
      metadata: "metadata",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
    };

    export interface T {
      id: string;
      provider_id: string | null;
      clinic_id: string;
      patient_id: string;
      user_id: string;
      current_visit_id: string;
      fulfilled_visit_id: string | null;
      timestamp: ColumnType<Date, string | undefined, Date | string>;
      duration: number;
      reason: string;
      notes: string;
      status: string;
      departments: JSONColumnType<
        Array<{
          id: string;
          name: string;
          seen_at: string | null;
          seen_by: string | null;
          status:
            | "pending"
            | "in_progress"
            | "completed"
            | "checked_in"
            | "cancelled";
        }>
      >;
      is_walk_in: boolean;
      metadata: JSONColumnType<Record<string, unknown>>;
      is_deleted: Generated<boolean>;
      created_at: Generated<ColumnType<Date, string | undefined, never>>;
      updated_at: Generated<
        ColumnType<Date, string | undefined, string | undefined>
      >;
      last_modified: Generated<ColumnType<Date, string | undefined, never>>;
      server_created_at: Generated<ColumnType<Date, string | undefined, never>>;
      deleted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
    }

    export type Appointments = Selectable<T>;
    export type NewAppointments = Insertable<T>;
    export type AppointmentsUpdate = Updateable<T>;
  }

  export namespace API {
    export const getAll = createServerOnlyFn(async (): Promise<EncodedT[]> => {
      const res = await db
        .selectFrom(Appointment.Table.name)
        .where("is_deleted", "=", false)
        .selectAll()
        .execute();

      return res as unknown as EncodedT[];
    });

    export const getById = createServerOnlyFn(async (id: string) => {
      const res = await db
        .selectFrom(Appointment.Table.name)
        .where("id", "=", id)
        .where("is_deleted", "=", false)
        .selectAll()
        .executeTakeFirst();

      return res as unknown as EncodedT | null;
    });

    export const getByPatientId = createServerOnlyFn(
      async (patientId: string) => {
        const res = await db.executeQuery<{
          appointment: Appointment.EncodedT;
          patient: Patient.EncodedT;
          clinic: Clinic.EncodedT;
          provider: User.EncodedT;
        }>(
          sql`
        SELECT
          row_to_json(appointments.*) as appointment,
          row_to_json(patients.*) as patient,
          row_to_json(clinics.*) as clinic,
          row_to_json(users.*) as provider
        FROM appointments
        INNER JOIN patients ON appointments.patient_id = patients.id
        INNER JOIN clinics ON appointments.clinic_id = clinics.id
        LEFT JOIN users ON appointments.provider_id = users.id
        WHERE appointments.is_deleted = false
        AND appointments.patient_id = ${patientId}
        ORDER BY appointments.timestamp DESC
      `.compile(db),
        );

        return res.rows || [];
      },
    );

    export const getAllWithDetails = createServerOnlyFn(async () => {
      const res = await db.executeQuery<{
        appointment: Appointment.EncodedT;
        patient: Patient.EncodedT;
        clinic: Clinic.EncodedT;
        provider: User.EncodedT;
      }>(
        sql`
              SELECT
                row_to_json(appointments.*) as appointment,
                row_to_json(patients.*) as patient,
                row_to_json(clinics.*) as clinic,
                row_to_json(users.*) as provider
              FROM appointments
              INNER JOIN patients ON appointments.patient_id = patients.id
              INNER JOIN clinics ON appointments.clinic_id = clinics.id
              LEFT JOIN users ON appointments.provider_id = users.id
              WHERE appointments.is_deleted = false
              ORDER BY appointments.timestamp DESC
              LIMIT 100
            `.compile(db),
      );

      return res.rows;
    });

    export const toggleStatus = createServerOnlyFn(
      async (id: string, status: string) => {
        await db
          .updateTable(Appointment.Table.name)
          .set({
            status,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
          })
          .where("id", "=", id)
          .execute();
      },
    );

    export const save = createServerOnlyFn(
      async (
        id: string | null,
        appointment: Appointment.EncodedT,
        currentUserName: string,
        fallbackUserId?: string | null,
        fallbackClinicId?: string | null,
      ) => {
        Logger.warn({
          msg: "Checking for",
          patient_id: appointment.patient_id,
        });
        try {
          // Resolve required UUID fields, falling back to caller-provided values when the appointment data is invalid
          const resolvedClinicId = isValidUUID(appointment.clinic_id)
            ? appointment.clinic_id
            : fallbackClinicId;
          const resolvedUserId = isValidUUID(appointment.user_id)
            ? appointment.user_id
            : fallbackUserId;

          if (!resolvedClinicId || !isValidUUID(resolvedClinicId)) {
            throw new Error(
              `Invalid or missing clinic_id: "${appointment.clinic_id}" is not a valid UUID and no fallback available`,
            );
          }
          if (!isValidUUID(appointment.patient_id)) {
            throw new Error(
              `Invalid or missing patient_id: "${appointment.patient_id}" is not a valid UUID`,
            );
          }
          if (!resolvedUserId || !isValidUUID(resolvedUserId)) {
            throw new Error(
              `Invalid or missing user_id: "${appointment.user_id}" is not a valid UUID and no fallback available`,
            );
          }

          return await db.transaction().execute(async (trx) => {
            let visitId =
              appointment.current_visit_id &&
              isValidUUID(appointment.current_visit_id)
                ? appointment.current_visit_id
                : uuidV1();
            if (!isValidUUID(appointment.current_visit_id)) {
              const visit = await trx
                .insertInto(Visit.Table.name)
                .values({
                  id: visitId,
                  patient_id: appointment.patient_id,
                  clinic_id: resolvedClinicId,
                  provider_id: resolvedUserId, // the user_id is that of the current user, to a visit that is the provider
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

              visitId = visit.id;
            }

            const res = await trx
              .insertInto(Appointment.Table.name)
              .values({
                id: id || appointment.id || uuidV1(),
                clinic_id: resolvedClinicId,
                patient_id: appointment.patient_id,
                user_id: resolvedUserId,
                current_visit_id: visitId,
                created_at: sql`${toSafeDateString(
                  appointment.created_at,
                )}::timestamp with time zone`,
                updated_at: sql`${toSafeDateString(
                  appointment.updated_at,
                )}::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
                server_created_at: sql`now()::timestamp with time zone`,
                deleted_at: null,
                departments: sql`${JSON.stringify(
                  safeJSONParse(appointment.departments, []),
                )}::jsonb`,
                is_walk_in: appointment.is_walk_in,
                metadata: sql`${JSON.stringify(
                  safeJSONParse(appointment.metadata, {}),
                )}::jsonb`,
                duration: appointment.duration,
                reason: appointment.reason,
                notes: appointment.notes,
                status: appointment.status,
                fulfilled_visit_id:
                  appointment.fulfilled_visit_id &&
                  isValidUUID(appointment.fulfilled_visit_id)
                    ? appointment.fulfilled_visit_id
                    : null,
                timestamp: sql`${toSafeDateString(
                  appointment.timestamp,
                )}::timestamp with time zone`,
                is_deleted: false,
                // the provider is the user who attends the appointment, this might be known ahead of time or not.
                provider_id:
                  appointment.provider_id &&
                  isValidUUID(appointment.provider_id)
                    ? appointment.provider_id
                    : null,
              })
              .onConflict((oc) => {
                return (
                  oc
                    .column("id")
                    .doUpdateSet({
                      id: (eb) => eb.ref("excluded.id"),
                      clinic_id: resolvedClinicId,
                      patient_id: (eb) => eb.ref("excluded.patient_id"),
                      user_id: (eb) => eb.ref("excluded.user_id"),
                      current_visit_id: (eb) =>
                        eb.ref("excluded.current_visit_id"),
                      created_at: sql`${toSafeDateString(
                        appointment.created_at,
                      )}::timestamp with time zone`,
                      updated_at: sql`${toSafeDateString(
                        appointment.updated_at,
                      )}::timestamp with time zone`,
                      last_modified: sql`now()::timestamp with time zone`,
                      deleted_at: (eb) => eb.ref("excluded.deleted_at"),
                      departments: (eb) => eb.ref("excluded.departments"),
                      is_walk_in: appointment.is_walk_in,
                      metadata: (eb) => eb.ref("excluded.metadata"),
                      duration: appointment.duration,
                      reason: appointment.reason,
                      notes: appointment.notes,
                      status: appointment.status,
                      fulfilled_visit_id:
                        appointment.fulfilled_visit_id &&
                        isValidUUID(appointment.fulfilled_visit_id)
                          ? appointment.fulfilled_visit_id
                          : null,
                      timestamp: sql`${toSafeDateString(
                        appointment.timestamp,
                      )}::timestamp with time zone`,
                      is_deleted: false,
                      provider_id:
                        appointment.provider_id &&
                        isValidUUID(appointment.provider_id)
                          ? appointment.provider_id
                          : null,
                    })
                    // Only update if the incoming record is newer than what's already stored
                    .where(
                      sql<boolean>`excluded.updated_at > appointments.updated_at`,
                    )
                );
              })
              .executeTakeFirst();

            if (!res) {
              // Stale record skipped by the updated_at guard
              Logger.info(
                `[sync] Skipped stale upsert for appointment ${appointment.id}`,
              );
            }

            return {
              numInsertedOrUpdatedRows: Number(
                res?.numInsertedOrUpdatedRows ?? 0,
              ),
            };
          });
        } catch (error) {
          Logger.error({
            msg: "Appointment upsert operation failed:",
            error: {
              operation: "appointment_upsert",
              error: {
                message: error instanceof Error ? error.message : String(error),
                name:
                  error instanceof Error ? error.constructor.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
              },
              context: {
                appointmentId: appointment.id,
              },
              timestamp: new Date().toISOString(),
            },
          });
          throw error;
        }
      },
    );

    export const softDelete = createServerOnlyFn(async (id: string) => {
      return await db
        .updateTable(Table.name)
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
      async (delta: Appointment.EncodedT, caller: RequestCaller) => {
        const { currentUserName, fallbackUserId, fallbackClinicId } = match(
          caller,
        )
          .with({ device: P.select() }, (_) => ({
            currentUserName: "",
            fallbackUserId: null as string | null,
            fallbackClinicId: null as string | null,
          }))
          .with({ user: P.select() }, (user) => ({
            currentUserName: user.name,
            fallbackUserId: user.id,
            fallbackClinicId: user.clinic_id,
          }))
          .exhaustive();
        return API.save(
          delta.id || uuidv7(),
          delta,
          currentUserName,
          fallbackUserId,
          fallbackClinicId,
        );
      },
    );

    export const deleteFromDelta = createServerOnlyFn(async (id: string) => {
      return API.softDelete(id);
    });
  }
}

export default Appointment;
