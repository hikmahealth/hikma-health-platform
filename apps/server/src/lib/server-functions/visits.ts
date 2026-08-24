import { createServerFn } from "@tanstack/react-start";
import { userRoleTokenHasCapability } from "../auth/request";
import User from "@/models/user";
import Visit from "@/models/visit";
import Event from "@/models/event";
import * as Sentry from "@sentry/tanstackstart-react";
import { permissionsMiddleware } from "@/middleware/auth";
import db from "@/db";
import { sql } from "kysely";
import {
  type CreateVisitInput,
  type Pagination,
  buildVisitInsertValues,
} from "./builders";
import { logAuditEvent } from "./audit";
import { Result } from "@/lib/result";

/** A visit with its associated events pre-loaded. */
export type VisitWithEvents = Visit.EncodedT & {
  events: Event.EncodedT[];
};

/** A patient's visits, most recent first, paginated. Online mode only. */
export const getPatientVisits = createServerFn({ method: "GET" })
  .validator(
    (data: {
      patientId: string;
      offset?: number;
      limit?: number;
      includeEvents?: boolean;
    }) => data,
  )
  .handler(
    async ({
      data,
    }): Promise<
      Result<{
        items: VisitWithEvents[];
        pagination: Pagination;
      }>
    > => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.READ_ALL_PATIENT,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "getPatientVisits",
        });
      }

      try {
        const result = await Visit.API.getByPatientId({
          patientId: data.patientId,
          limit: data.limit ?? 50,
          offset: data.offset ?? 0,
          includeCount: true,
        });

        let items: VisitWithEvents[];

        if (data.includeEvents && result.items.length > 0) {
          const visitIds = result.items.map((v) => v.id);
          const events = await db
            .selectFrom(Event.Table.name)
            .selectAll()
            .where("visit_id", "in", visitIds)
            .where("is_deleted", "=", false)
            .orderBy("created_at", "desc")
            .execute();

          const eventsByVisit = new Map<string, Event.EncodedT[]>();
          for (const e of events) {
            const list = eventsByVisit.get(e.visit_id!) ?? [];
            list.push(e as unknown as Event.EncodedT);
            eventsByVisit.set(e.visit_id!, list);
          }

          items = result.items.map((v) => ({
            ...v,
            events: eventsByVisit.get(v.id) ?? [],
          }));
        } else {
          items = result.items.map((v) => ({ ...v, events: [] }));
        }

        return Result.ok({ items, pagination: result.pagination });
      } catch (error) {
        Sentry.captureException(error);
        return Result.err({
          _tag: "ServerError" as const,
          message:
            error instanceof Error ? error.message : "Failed to fetch visits",
        });
      }
    },
  );

/** Create a visit for a patient. Online mode only. Returns the new visit id. */
export const createVisit = createServerFn({ method: "POST" })
  .validator((data: CreateVisitInput) => data)
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
          source: "createVisit",
        });
      }

      return Sentry.startSpan({ name: "createVisit" }, async () => {
        try {
          const values = buildVisitInsertValues(data);
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
            changes: data,
            userId: context.userId,
          });

          return { success: true as const, id: visitId };
        } catch (error) {
          Sentry.captureException(error);
          return {
            success: false as const,
            error:
              error instanceof Error ? error.message : "Failed to create visit",
          };
        }
      });
    },
  );
