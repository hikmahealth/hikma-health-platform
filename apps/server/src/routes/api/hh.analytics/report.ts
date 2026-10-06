import { authAnalyticsMiddleware } from "@/middleware/analytics";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import db from "@/db";
import { sql } from "kysely";
import { addDays, format, isAfter, isValid } from "date-fns";

const data = <T>(d: T) => {
  return new Response(JSON.stringify(d), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const dateField = z
  .string()
  .or(z.iso.date())
  .transform((d) => new Date(d))
  .refine((d) => isValid(d), "Invalid date");

const reportSchema = z
  .object({
    startDate: dateField,
    endDate: dateField,
  })
  .refine((v) => !isAfter(v.startDate, v.endDate), {
    message: "startDate must not be after endDate",
    path: ["startDate"],
  });

type DailyCounts = { total: number; count: [string, number][] };

/**
 * Builds a zero-filled daily series from startDate to endDate (inclusive)
 * out of the sparse `(day, count)` rows returned by the database.
 */
function toDailySeries(
  rows: { day: string; count: string | number }[],
  startDate: Date,
  endDate: Date,
): DailyCounts {
  const byDay = new Map(rows.map((r) => [r.day, Number(r.count)]));
  const count: [string, number][] = [];
  let total = 0;
  for (
    let d = startDate;
    format(d, "yyyy-MM-dd") <= format(endDate, "yyyy-MM-dd");
    d = addDays(d, 1)
  ) {
    const key = format(d, "yyyy-MM-dd");
    const n = byDay.get(key) ?? 0;
    total += n;
    count.push([key, n]);
  }
  return { total, count };
}

/**
 * This endpoint is exposed so that it may be called by the administrator portal
 * 1.⁠ ⁠Number of patients registered in the last 3 calendar months (with a daily breakdown that we can aggregate as needed)
 * 2.⁠ ⁠⁠Number of patient visits in the last 3 calendar months (with a daily breakdown that we can aggregate as needed)
 * 3. total patients overall
 */
export const Route = createFileRoute("/api/hh/analytics/report")({
  server: {
    middleware: [authAnalyticsMiddleware],
    handlers: {
      /**
       * Generates a report on the instance then send's to the intended recipient
       */
      POST: async function ({ request }) {
        const parsed = reportSchema.safeParse(await request.json());
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: parsed.error.flatten() }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const { startDate, endDate } = parsed.data;
        const start = format(startDate, "yyyy-MM-dd");
        const end = format(endDate, "yyyy-MM-dd");

        // total number of patients overall
        const totalPatientsQuery = db
          .selectFrom("patients")
          .select(sql<string>`COUNT(*)`.as("count"))
          .where("is_deleted", "=", false);

        // daily counts, inclusive of both startDate and endDate
        const dailyCounts = (table: "patients" | "visits") =>
          db
            .selectFrom(table)
            .select([
              sql<string>`to_char(${sql.ref(`${table}.server_created_at`)}, 'YYYY-MM-DD')`.as(
                "day",
              ),
              sql<string>`COUNT(*)`.as("count"),
            ])
            .where(`${table}.is_deleted`, "=", false)
            .where(
              sql<boolean>`${sql.ref(`${table}.server_created_at`)} >= ${start}::date`,
            )
            .where(
              sql<boolean>`${sql.ref(`${table}.server_created_at`)} < (${end}::date + 1)`,
            )
            .groupBy("day")
            .execute();

        const [totalPatients, patientRows, visitRows] = await Promise.all([
          totalPatientsQuery.executeTakeFirstOrThrow(),
          dailyCounts("patients"),
          dailyCounts("visits"),
        ]);

        return data({
          start_date: start,
          end_date: end,
          total_patients: Number(totalPatients.count),
          patients_registered: toDailySeries(patientRows, startDate, endDate),
          visits: toDailySeries(visitRows, startDate, endDate),
        });
      },
    },
  },
});
