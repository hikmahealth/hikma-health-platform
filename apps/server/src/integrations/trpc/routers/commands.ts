/**
 * tRPC mutation procedures (CQRS write side).
 * Served at /rpc/command via fetchRequestHandler.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { TRPCRouterRecord } from "@trpc/server";
import { authedProcedure, publicProcedure, requireClinicPermission } from "../init";
import Patient from "@/models/patient";
import PatientAdditionalAttribute from "@/models/patient-additional-attribute";
import Visit from "@/models/visit";
import Event from "@/models/event";
import EventProblems from "@/models/event-problems";
import User from "@/models/user";
import db from "@/db";
import { sql } from "kysely";
import * as Sentry from "@sentry/tanstackstart-react";
import {
  buildPatientInsertValues,
  buildPatientAttributeInsertValues,
  buildVisitInsertValues,
  buildEventInsertValues,
} from "@/lib/server-functions/builders";
import { logAuditEvent } from "@/lib/server-functions/audit";

const additionalAttributeSchema = z.object({
  attribute_id: z.string(),
  attribute: z.string(),
  number_value: z.number().nullish(),
  string_value: z.string().nullish(),
  date_value: z.string().nullish(),
  boolean_value: z.boolean().nullish(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const createPatientSchema = z.object({
  patient: z.object({
    given_name: z.string().nullish(),
    surname: z.string().nullish(),
    date_of_birth: z.string().nullish(),
    sex: z.string().nullish(),
    citizenship: z.string().nullish(),
    hometown: z.string().nullish(),
    phone: z.string().nullish(),
    camp: z.string().nullish(),
    government_id: z.string().nullish(),
    external_patient_id: z.string().nullish(),
    additional_data: z.record(z.string(), z.any()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    photo_url: z.string().nullish(),
    primary_clinic_id: z.string().nullish(),
  }),
  additional_attributes: z.array(additionalAttributeSchema).optional(),
});

const updatePatientSchema = z.object({
  id: z.string(),
  fields: z
    .object({
      given_name: z.string().nullish(),
      surname: z.string().nullish(),
      date_of_birth: z.string().nullish(),
      sex: z.string().nullish(),
      citizenship: z.string().nullish(),
      hometown: z.string().nullish(),
      phone: z.string().nullish(),
      camp: z.string().nullish(),
      government_id: z.string().nullish(),
      external_patient_id: z.string().nullish(),
      additional_data: z.record(z.string(), z.any()).optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      photo_url: z.string().nullish(),
      primary_clinic_id: z.string().nullish(),
    })
    .partial(),
});

const createVisitSchema = z.object({
  patient_id: z.string(),
  clinic_id: z.string(),
  provider_id: z.string(),
  provider_name: z.string().nullish(),
  check_in_timestamp: z.string().nullish(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const createEventSchema = z.object({
  patient_id: z.string(),
  visit_id: z.string(),
  event_type: z.string().nullish(),
  form_id: z.string().nullish(),
  form_data: z.array(z.record(z.string(), z.any())),
  metadata: z.record(z.string(), z.any()).optional(),
});

const updateEventSchema = z.object({
  id: z.string(),
  form_data: z.array(z.record(z.string(), z.any())),
  metadata: z.record(z.string(), z.any()).optional(),
});

/**
 * Record an event's diagnoses on the patient's chart.
 *
 * The event is already committed by the time this runs — they are not one
 * transaction — so throwing would 500 a client whose save succeeded and invite
 * a retry into a duplicate. Failures are reported and dropped instead;
 * reconciliation is idempotent, so the next edit of the event puts it right.
 */
async function recordEventProblems(
  input: Parameters<typeof EventProblems.reconcile>[0],
): Promise<void> {
  try {
    await EventProblems.reconcile(input);
  } catch (error) {
    Sentry.captureException(error, {
      level: "error",
      extra: { eventId: input.eventId, formId: input.formId },
    });
  }
}

/** Hub-compatible patient registration schema with client-provided id and ms-epoch timestamps */
const registerPatientSchema = z.object({
  patient: z.object({
    id: z.string(),
    given_name: z.string().nullish(),
    surname: z.string().nullish(),
    date_of_birth: z.string().nullish(),
    sex: z.string().nullish(),
    citizenship: z.string().nullish(),
    hometown: z.string().nullish(),
    phone: z.string().nullish(),
    camp: z.string().nullish(),
    government_id: z.string().nullish(),
    external_patient_id: z.string().nullish(),
    additional_data: z.record(z.string(), z.any()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    photo_url: z.string().nullish(),
    primary_clinic_id: z.string().nullish(),
    created_at: z.number().nullish(),
    updated_at: z.number().nullish(),
  }),
  additional_attributes: z.array(additionalAttributeSchema).optional(),
});

export const commandProcedures = {
  /** Health check / connectivity probe */
  ping: publicProcedure.mutation(() => ({ pong: true as const })),

  /** Authenticate with email/password and receive a bearer token */
  login: publicProcedure
    .input(z.object({ email: z.string(), password: z.string() }))
    .mutation(async ({ input }) => {
      try {
        // No explicit lifetime: the 2-hour default is standard across every
        // login path. This one used to mint 24-hour tokens.
        const { user, token } = await User.signIn(input.email, input.password);
        return {
          token,
          user_id: user.id,
          clinic_id: user.clinic_id,
          role: user.role,
        };
      } catch (error) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Invalid email or password",
        });
      }
    }),

  /** Hub-compatible patient registration with upsert semantics */
  register_patient: authedProcedure
    .input(registerPatientSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const pt = input.patient;
        const patientId = pt.id;

        requireClinicPermission(ctx, "can_register_patients", pt.primary_clinic_id);

        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto(Patient.Table.name)
            .values({
              id: patientId,
              given_name: pt.given_name ?? null,
              surname: pt.surname ?? null,
              date_of_birth: pt.date_of_birth
                ? sql`${pt.date_of_birth}::date`
                : null,
              citizenship: pt.citizenship ?? null,
              hometown: pt.hometown ?? null,
              phone: pt.phone ?? null,
              sex: pt.sex ?? null,
              camp: pt.camp ?? null,
              additional_data: sql`${JSON.stringify(pt.additional_data ?? {})}::jsonb`,
              metadata: sql`${JSON.stringify(pt.metadata ?? {})}::jsonb`,
              photo_url: pt.photo_url ?? null,
              government_id: pt.government_id ?? null,
              external_patient_id: pt.external_patient_id ?? null,
              primary_clinic_id: pt.primary_clinic_id ?? null,
              last_modified_by: ctx.userId,
              is_deleted: false,
              created_at: pt.created_at
                ? sql`to_timestamp(${pt.created_at} / 1000.0)`
                : sql`now()::timestamp with time zone`,
              updated_at: sql`now()::timestamp with time zone`,
              last_modified: sql`now()::timestamp with time zone`,
              server_created_at: sql`now()::timestamp with time zone`,
              deleted_at: null,
            })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({
                given_name: pt.given_name ?? null,
                surname: pt.surname ?? null,
                date_of_birth: pt.date_of_birth
                  ? sql`${pt.date_of_birth}::date`
                  : null,
                citizenship: pt.citizenship ?? null,
                hometown: pt.hometown ?? null,
                phone: pt.phone ?? null,
                sex: pt.sex ?? null,
                camp: pt.camp ?? null,
                additional_data: sql`${JSON.stringify(pt.additional_data ?? {})}::jsonb`,
                metadata: sql`${JSON.stringify(pt.metadata ?? {})}::jsonb`,
                photo_url: pt.photo_url ?? null,
                government_id: pt.government_id ?? null,
                external_patient_id: pt.external_patient_id ?? null,
                primary_clinic_id: pt.primary_clinic_id ?? null,
                last_modified_by: ctx.userId,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
              }),
            )
            .executeTakeFirst();

          const attrs = input.additional_attributes ?? [];
          for (const attr of attrs) {
            const attrValues = buildPatientAttributeInsertValues(patientId, [
              attr,
            ]);
            const av = attrValues[0];
            await trx
              .insertInto(PatientAdditionalAttribute.Table.name)
              .values({
                id: av.id,
                patient_id: av.patient_id,
                attribute_id: av.attribute_id,
                attribute: av.attribute,
                number_value: av.number_value,
                string_value: av.string_value,
                date_value: av.date_value
                  ? sql`${av.date_value}::timestamp with time zone`
                  : null,
                boolean_value: av.boolean_value,
                metadata: sql`${JSON.stringify(av.metadata)}::jsonb`,
                is_deleted: false,
                created_at: sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
                server_created_at: sql`now()::timestamp with time zone`,
                deleted_at: null,
              })
              .onConflict((oc) =>
                oc
                  .columns(["patient_id", "attribute_id"])
                  .doUpdateSet({
                    attribute: av.attribute,
                    number_value: av.number_value,
                    string_value: av.string_value,
                    date_value: av.date_value
                      ? sql`${av.date_value}::timestamp with time zone`
                      : null,
                    boolean_value: av.boolean_value,
                    metadata: sql`${JSON.stringify(av.metadata)}::jsonb`,
                    updated_at: sql`now()::timestamp with time zone`,
                    last_modified: sql`now()::timestamp with time zone`,
                  }),
              )
              .executeTakeFirst();
          }
        });

        await logAuditEvent({
          actionType: "UPSERT",
          tableName: "patients",
          rowId: patientId,
          changes: {
            ...input.patient,
            additionalAttributes: input.additional_attributes ?? [],
          },
          userId: ctx.userId,
        });

        return {
          patient_id: patientId,
          attributes_count: (input.additional_attributes ?? []).length,
        };
      } catch (error) {
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to register patient",
        });
      }
    }),

  /** Create a new patient with optional additional attributes in an atomic transaction */
  create_patient: authedProcedure
    .input(createPatientSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const values = buildPatientInsertValues(input.patient);
        const patientId = values.id;

        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto(Patient.Table.name)
            .values({
              id: values.id,
              given_name: values.given_name,
              surname: values.surname,
              date_of_birth: values.date_of_birth
                ? sql`${values.date_of_birth}::date`
                : null,
              citizenship: values.citizenship,
              hometown: values.hometown,
              phone: values.phone,
              sex: values.sex,
              camp: values.camp,
              additional_data: sql`${JSON.stringify(values.additional_data)}::jsonb`,
              metadata: sql`${JSON.stringify(values.metadata)}::jsonb`,
              photo_url: values.photo_url,
              government_id: values.government_id,
              external_patient_id: values.external_patient_id,
              primary_clinic_id: values.primary_clinic_id,
              last_modified_by: ctx.userId,
              is_deleted: false,
              created_at: sql`now()::timestamp with time zone`,
              updated_at: sql`now()::timestamp with time zone`,
              last_modified: sql`now()::timestamp with time zone`,
              server_created_at: sql`now()::timestamp with time zone`,
              deleted_at: null,
            })
            .executeTakeFirstOrThrow();

          const attrs = input.additional_attributes ?? [];
          if (attrs.length > 0) {
            const attrValues = buildPatientAttributeInsertValues(
              patientId,
              attrs,
            );
            for (const attr of attrValues) {
              await trx
                .insertInto(PatientAdditionalAttribute.Table.name)
                .values({
                  id: attr.id,
                  patient_id: attr.patient_id,
                  attribute_id: attr.attribute_id,
                  attribute: attr.attribute,
                  number_value: attr.number_value,
                  string_value: attr.string_value,
                  date_value: attr.date_value
                    ? sql`${attr.date_value}::timestamp with time zone`
                    : null,
                  boolean_value: attr.boolean_value,
                  metadata: sql`${JSON.stringify(attr.metadata)}::jsonb`,
                  is_deleted: false,
                  created_at: sql`now()::timestamp with time zone`,
                  updated_at: sql`now()::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                  server_created_at: sql`now()::timestamp with time zone`,
                  deleted_at: null,
                })
                .executeTakeFirst();
            }
          }
        });

        await logAuditEvent({
          actionType: "CREATE",
          tableName: "patients",
          rowId: patientId,
          changes: {
            ...input.patient,
            additionalAttributes: input.additional_attributes ?? [],
          },
          userId: ctx.userId,
        });

        return { success: true as const, id: patientId };
      } catch (error) {
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to create patient",
        });
      }
    }),

  /** Update an existing patient's fields. Only provided fields are updated. */
  update_patient: authedProcedure
    .input(updatePatientSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const updateSet: Record<string, any> = {};
        const { fields } = input;

        if (fields.given_name !== undefined)
          updateSet.given_name = fields.given_name;
        if (fields.surname !== undefined) updateSet.surname = fields.surname;
        if (fields.date_of_birth !== undefined) {
          updateSet.date_of_birth = fields.date_of_birth
            ? sql`${fields.date_of_birth}::date`
            : null;
        }
        if (fields.sex !== undefined) updateSet.sex = fields.sex;
        if (fields.citizenship !== undefined)
          updateSet.citizenship = fields.citizenship;
        if (fields.hometown !== undefined) updateSet.hometown = fields.hometown;
        if (fields.phone !== undefined) updateSet.phone = fields.phone;
        if (fields.camp !== undefined) updateSet.camp = fields.camp;
        if (fields.government_id !== undefined)
          updateSet.government_id = fields.government_id;
        if (fields.external_patient_id !== undefined)
          updateSet.external_patient_id = fields.external_patient_id;
        if (fields.additional_data !== undefined)
          updateSet.additional_data = sql`${JSON.stringify(fields.additional_data)}::jsonb`;
        if (fields.metadata !== undefined)
          updateSet.metadata = sql`${JSON.stringify(fields.metadata)}::jsonb`;
        if (fields.photo_url !== undefined)
          updateSet.photo_url = fields.photo_url;
        if (fields.primary_clinic_id !== undefined)
          updateSet.primary_clinic_id = fields.primary_clinic_id;

        updateSet.updated_at = sql`now()::timestamp with time zone`;
        updateSet.last_modified = sql`now()::timestamp with time zone`;
        updateSet.last_modified_by = ctx.userId;

        await db
          .updateTable(Patient.Table.name)
          .set(updateSet)
          .where("id", "=", input.id)
          .where("is_deleted", "=", false)
          .execute();

        await logAuditEvent({
          actionType: "UPDATE",
          tableName: "patients",
          rowId: input.id,
          changes: input.fields,
          userId: ctx.userId,
        });

        return { success: true as const };
      } catch (error) {
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to update patient",
        });
      }
    }),

  /** Create a new visit record for a patient */
  create_visit: authedProcedure
    .input(createVisitSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const values = buildVisitInsertValues({
          patientId: input.patient_id,
          clinicId: input.clinic_id,
          providerId: input.provider_id,
          providerName: input.provider_name,
          checkInTimestamp: input.check_in_timestamp,
          metadata: input.metadata,
        });
        const visitId = values.id;

        await db
          .insertInto(Visit.Table.name)
          .values({
            id: values.id,
            patient_id: values.patient_id,
            clinic_id: values.clinic_id,
            provider_id: values.provider_id,
            provider_name: values.provider_name,
            check_in_timestamp: values.check_in_timestamp
              ? sql`${values.check_in_timestamp}::timestamp with time zone`
              : null,
            metadata: sql`${JSON.stringify(values.metadata)}::jsonb`,
            is_deleted: false,
            created_at: sql`now()::timestamp with time zone`,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
            server_created_at: sql`now()::timestamp with time zone`,
            deleted_at: null,
          })
          .executeTakeFirstOrThrow();

        await logAuditEvent({
          actionType: "CREATE",
          tableName: "visits",
          rowId: visitId,
          changes: input,
          userId: ctx.userId,
        });

        return { success: true as const, id: visitId };
      } catch (error) {
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to create visit",
        });
      }
    }),

  /** Create a new event within an existing visit */
  create_event: authedProcedure
    .input(createEventSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const values = buildEventInsertValues(
          {
            patientId: input.patient_id,
            visitId: input.visit_id,
            eventType: input.event_type,
            formId: input.form_id,
            formData: input.form_data,
            metadata: input.metadata,
          },
          { recordedByUserId: ctx.userId },
        );
        const eventId = values.id;

        await db
          .insertInto(Event.Table.name)
          .values({
            id: values.id,
            patient_id: values.patient_id,
            visit_id: values.visit_id,
            form_id: values.form_id,
            event_type: values.event_type,
            form_data: sql`${JSON.stringify(values.form_data)}::jsonb`,
            metadata: sql`${JSON.stringify(values.metadata)}::jsonb`,
            recorded_by_user_id: values.recorded_by_user_id,
            is_deleted: false,
            created_at: sql`now()::timestamp with time zone`,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
            server_created_at: sql`now()::timestamp with time zone`,
            deleted_at: null,
          })
          .executeTakeFirstOrThrow();

        await recordEventProblems({
          eventId,
          patientId: values.patient_id,
          visitId: values.visit_id,
          formId: values.form_id,
          formData: input.form_data,
          previousFormData: [],
          recordedByUserId: ctx.userId,
        });

        await logAuditEvent({
          actionType: "CREATE",
          tableName: "events",
          rowId: eventId,
          changes: { ...input, recorded_by_user_id: ctx.userId },
          userId: ctx.userId,
        });

        return { success: true as const, id: eventId };
      } catch (error) {
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to create event",
        });
      }
    }),

  /** Update the form data and optionally metadata for an existing event */
  update_event: authedProcedure
    .input(updateEventSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        // Read before the write: reconciling needs the diagnoses this event
        // asked to record last time, so a problem taken off the chart by hand
        // is not put back.
        const before = await Event.API.getFormContextById(input.id);

        await Event.API.updateFormData(input.id, input.form_data, input.metadata);

        if (before) {
          await recordEventProblems({
            eventId: input.id,
            patientId: before.patientId,
            visitId: before.visitId,
            formId: before.formId,
            formData: input.form_data,
            previousFormData: before.formData,
            recordedByUserId: ctx.userId,
          });
        }

        await logAuditEvent({
          actionType: "UPDATE",
          tableName: "events",
          rowId: input.id,
          changes: { formData: input.form_data, metadata: input.metadata },
          userId: ctx.userId,
        });

        return { success: true as const };
      } catch (error) {
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            error instanceof Error
              ? error.message
              : "Failed to update event",
        });
      }
    }),
} satisfies TRPCRouterRecord;
