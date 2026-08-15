import { createServerFn } from "@tanstack/react-start";
import Patient from "@/models/patient";
import { userRoleTokenHasCapability } from "../auth/request";
import User from "@/models/user";
import * as Sentry from "@sentry/tanstackstart-react";
import z from "zod";
import { permissionsMiddleware } from "@/middleware/auth";
import db from "@/db";
import { sql } from "kysely";
import PatientAdditionalAttribute from "@/models/patient-additional-attribute";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import {
  type CreatePatientInput,
  type UpdatePatientInput,
  buildPatientInsertValues,
  buildPatientAttributeInsertValues,
} from "./builders";
import { logAuditEvent } from "./audit";
import { adminMiddleware } from "@/middleware/auth";

type Pagination = {
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
};

export const getAllPatients = createServerFn({
  method: "GET",
})
  .inputValidator((data?: { offset?: number; limit?: number }) => data || {})
  .handler(
    async ({
      data,
    }): Promise<{
      patients: (typeof Patient.PatientWithAttributesSchema.Encoded)[];
      pagination: Pagination;
      error: { message: string } | null;
    }> => {
      return Sentry.startSpan({ name: "getAllPatients" }, async () => {
        const authorized = await userRoleTokenHasCapability([
          User.CAPABILITIES.READ_ALL_PATIENT,
        ]);

        if (!authorized) {
          return {
            patients: [],
            pagination: {
              offset: 0,
              limit: 50,
              total: 0,
              hasMore: false,
            },
            error: {
              message: "Unauthorized: Insufficient permissions",
              source: "getAllPatients",
            },
          };
        }
        const { patients, pagination } = await Patient.API.getAllWithAttributes(
          {
            limit: data?.limit || 50,
            offset: data?.offset || 0,
            includeCount: true,
          },
        );
        return { patients: patients, pagination, error: null };
      });
    },
  );

// Search patients with text query and optional date filters
export const searchPatients = createServerFn({ method: "GET" })
  .inputValidator(
    (data: {
      searchQuery: string;
      offset?: number;
      limit?: number;
      registrationDateStart?: string;
      registrationDateEnd?: string;
      visitsDateStart?: string;
      visitsDateEnd?: string;
      clinicIds?: string[];
    }) => data,
  )
  .handler(
    async ({
      data,
    }): Promise<{
      patients: (typeof Patient.PatientWithAttributesSchema.Encoded)[];
      pagination: Pagination;
      error: { message: string } | null;
    }> => {
      return Sentry.startSpan({ name: "searchPatients" }, async () => {
        const authorized = await userRoleTokenHasCapability([
          User.CAPABILITIES.READ_ALL_PATIENT,
        ]);

        if (!authorized) {
          return {
            patients: [],
            pagination: {
              offset: 0,
              limit: data.limit || 10,
              total: 0,
              hasMore: false,
            },
            error: {
              message: "Unauthorized: Insufficient permissions",
              source: "searchPatients",
            },
          };
        }

        const offset = data.offset || 0;
        const limit = data.limit || 10;

        const hasTextQuery = data.searchQuery && data.searchQuery.trim() !== "";
        const hasDateFilters =
          data.registrationDateStart ||
          data.registrationDateEnd ||
          data.visitsDateStart ||
          data.visitsDateEnd;
        const hasClinicFilter = data.clinicIds && data.clinicIds.length > 0;

        // If no filters at all, use getAllWithAttributes for better performance
        if (!hasTextQuery && !hasDateFilters && !hasClinicFilter) {
          const result = await Patient.API.getAllWithAttributes({
            offset,
            limit,
            includeCount: true,
          });
          return {
            patients: result.patients,
            pagination: result.pagination,
            error: null,
          };
        }

        const result = await Patient.API.search({
          searchQuery: data.searchQuery,
          offset,
          limit,
          includeCount: true,
          registrationDateStart: data.registrationDateStart,
          registrationDateEnd: data.registrationDateEnd,
          visitsDateStart: data.visitsDateStart,
          visitsDateEnd: data.visitsDateEnd,
          clinicIds: data.clinicIds,
        });

        return {
          patients: result.patients,
          pagination: result.pagination,
          error: null,
        };
      });
    },
  );

export const getPatientById = createServerFn({
  method: "GET",
})
  .inputValidator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(
    async ({
      data,
    }): Promise<{
      patient: Patient.EncodedT;
      error: { message: string } | null;
    }> => {
      const patient = await Patient.API.getById(data.id);

      return {
        patient,
        error: null,
      };
    },
  );

/**
 * Soft delete a list of patients by their IDs.
 */
export const softDeletePatientsByIds = createServerFn({
  method: "POST",
})
  .inputValidator((data: { ids: string[] }) => data)
  .middleware([permissionsMiddleware])
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      success: boolean;
      error: { message: string } | null;
    }> => {
      if (!context.userId || context.role !== User.ROLES.SUPER_ADMIN) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions.",
          source: "softDeletePatientsByIds",
        });
      }

      // Soft delete each patient by ID
      await Patient.API.softDelete(data.ids);

      return {
        success: true,
        error: null,
      };
    },
  );

/**
 * Create a new patient with optional additional attributes in an atomic transaction.
 * This is an online-mode endpoint — the existing sync system continues to work independently.
 * @returns The new patient ID on success
 */
export const createPatient = createServerFn({ method: "POST" })
  .inputValidator((data: CreatePatientInput) => data)
  .middleware([permissionsMiddleware])
  .handler(
    async ({
      data,
      context,
    }): Promise<
      { success: true; id: string } | { success: false; error: string }
    > => {
      if (!context.userId) {
        return Promise.reject({
          message: "Unauthorized",
          source: "createPatient",
        });
      }

      return Sentry.startSpan({ name: "createPatient" }, async () => {
        try {
          const values = buildPatientInsertValues(data.patient);
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
                last_modified_by: context.userId,
                is_deleted: false,
                created_at: sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
                server_created_at: sql`now()::timestamp with time zone`,
                deleted_at: null,
              })
              .executeTakeFirstOrThrow();

            const attrs = data.additionalAttributes ?? [];
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
              ...data.patient,
              additionalAttributes: data.additionalAttributes ?? [],
            },
            userId: context.userId,
          });

          return { success: true as const, id: patientId };
        } catch (error) {
          Sentry.captureException(error);
          return {
            success: false as const,
            error:
              error instanceof Error
                ? error.message
                : "Failed to create patient",
          };
        }
      });
    },
  );

/**
 * Update an existing patient's fields. Only provided fields are updated.
 * This is an online-mode endpoint — the existing sync system continues to work independently.
 * @returns Success status
 */
export const updatePatient = createServerFn({ method: "POST" })
  .inputValidator((data: UpdatePatientInput) => data)
  .middleware([permissionsMiddleware])
  .handler(
    async ({
      data,
      context,
    }): Promise<{ success: true } | { success: false; error: string }> => {
      if (!context.userId) {
        return Promise.reject({
          message: "Unauthorized",
          source: "updatePatient",
        });
      }

      return Sentry.startSpan({ name: "updatePatient" }, async () => {
        try {
          const existing = await db
            .selectFrom(Patient.Table.name)
            .select(["primary_clinic_id", "is_deleted"])
            .where("id", "=", data.id)
            .executeTakeFirst();

          if (!existing || existing.is_deleted) {
            return {
              success: false as const,
              error: "Patient not found",
            };
          }

          // Clinic-scoped authorization, mirroring the `can_view_history`
          // scoping `Patient.API.getById` already applies for reads:
          // patients with no clinic assigned (legacy records) are editable
          // by anyone with `can_edit_records` in at least one clinic, patients
          // with a clinic require that specific clinic's permission.
          const editableClinicIds =
            await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
              "can_edit_records",
            );
          const authorized =
            existing.primary_clinic_id === null
              ? editableClinicIds.length > 0
              : editableClinicIds.includes(existing.primary_clinic_id);

          if (!authorized) {
            return {
              success: false as const,
              error: "Unauthorized: insufficient clinic permissions",
            };
          }

          const updateSet: Record<string, any> = {};
          const { fields } = data;

          // Build update set from provided fields
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
          if (fields.hometown !== undefined)
            updateSet.hometown = fields.hometown;
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

          // Always update timestamps
          updateSet.updated_at = sql`now()::timestamp with time zone`;
          updateSet.last_modified = sql`now()::timestamp with time zone`;
          updateSet.last_modified_by = context.userId;

          const attrs = data.additionalAttributes ?? [];
          const attrValues = buildPatientAttributeInsertValues(
            data.id,
            attrs,
          );

          // Same table + transaction, so a failed attribute write rolls
          // back the patient field update too — an edit is one operation
          // from the clinician's point of view, it shouldn't be able to
          // half-apply.
          await db.transaction().execute(async (trx) => {
            await trx
              .updateTable(Patient.Table.name)
              .set(updateSet)
              .where("id", "=", data.id)
              .where("is_deleted", "=", false)
              .execute();

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
                .onConflict((oc) =>
                  oc.columns(["patient_id", "attribute_id"]).doUpdateSet({
                    attribute: (eb) => eb.ref("excluded.attribute"),
                    number_value: (eb) => eb.ref("excluded.number_value"),
                    string_value: (eb) => eb.ref("excluded.string_value"),
                    date_value: (eb) => eb.ref("excluded.date_value"),
                    boolean_value: (eb) => eb.ref("excluded.boolean_value"),
                    metadata: (eb) => eb.ref("excluded.metadata"),
                    is_deleted: false,
                    updated_at: sql`now()::timestamp with time zone`,
                    last_modified: sql`now()::timestamp with time zone`,
                  }),
                )
                .executeTakeFirst();
            }
          });

          await logAuditEvent({
            actionType: "UPDATE",
            tableName: "patients",
            rowId: data.id,
            changes: { ...data.fields, additionalAttributes: attrs },
            userId: context.userId,
          });

          return { success: true as const };
        } catch (error) {
          Sentry.captureException(error);
          return {
            success: false as const,
            error:
              error instanceof Error
                ? error.message
                : "Failed to update patient",
          };
        }
      });
    },
  );
