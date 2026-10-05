import { authAnalyticsMiddleware } from "@/middleware/analytics";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { zodValidator } from "@tanstack/zod-adapter";
import db from "@/db";
import { sql } from "kysely";
import { format } from "date-fns";

const data = <T>(d: T) => {
  console.log("returned data --> ", d);
  return new Response(JSON.stringify(d), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const reportSchema = z.object({
  startDate: z
    .string()
    .or(z.date())
    .transform((d) => new Date(d))
    .nullish(),
  endDate: z
    .string()
    .or(z.date())
    .transform((d) => new Date(d))
    .nullish(),
});

/**
 * This endpoint is exposed so that it may be called by the administrator portal
 */
export const Route = createFileRoute("/api/hh/analytics/report")({
  validateSearch: zodValidator(reportSchema),
  server: {
    middleware: [authAnalyticsMiddleware],
    handlers: {
      /**
       * Generates a report on the instance then send's to the intended recipient
       */
      POST: async function ({ request }) {
        // total number of patients
        const patientsQuery = db
          .selectFrom("patients")
          .select(sql`COUNT(*)`.as("count"))
          .where("is_deleted", "=", false);

        // total number of patients between startDate <-> endDate
        const { startDate, endDate } = (await request.json()) as z.output<
          typeof reportSchema
        >;

        let patientCountInRange = db
          .selectFrom("patients")
          .select(sql`COUNT(*)`.as("count"))
          .where("is_deleted", "=", false);

        let visitsCountInRange = db
          .selectFrom("visits")
          .select(sql`COUNT(*)`.as("count"))
          .where("is_deleted", "=", false);

        if (startDate) {
          visitsCountInRange = visitsCountInRange.where(
            "visits.server_created_at",
            ">=",
            startDate,
          );
          patientCountInRange = patientCountInRange.where(
            "patients.server_created_at",
            ">=",
            startDate,
          );
        }

        if (endDate) {
          visitsCountInRange = visitsCountInRange.where(
            "visits.server_created_at",
            "<=",
            endDate,
          );
          patientCountInRange = patientCountInRange.where(
            "patients.server_created_at",
            "<=",
            endDate,
          );
        }

        const [
          patients,
          patientsBetweenStartDateAndEndDate,
          visitsBetweenStartDateAndEndDate,
        ] = await Promise.all([
          patientsQuery.executeTakeFirstOrThrow(),
          patientCountInRange.executeTakeFirstOrThrow(),
          visitsCountInRange.executeTakeFirstOrThrow(),
        ]);

        // the data to send to administrator
        return data({
          patients: patients.count,
          start_date: startDate ? format(startDate, "yyyy-MM-dd") : null,
          end_date: endDate ? format(endDate, "yyyy-MM-dd") : null,
          patients_within_date_range: patientsBetweenStartDateAndEndDate.count,
          visits_within_date_range: visitsBetweenStartDateAndEndDate.count,
        });
      },
    },
  },
});
