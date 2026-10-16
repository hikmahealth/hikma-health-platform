import { authAnalyticsMiddleware } from "@/middleware/analytics";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import db from "@/db";
import { sql } from "kysely";
import { addDays, format, isAfter, isValid, subMonths } from "date-fns";

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

// Missing or null dates default to the 3 months up to today.
const reportSchema = z
  .object({
    startDate: dateField.nullish(),
    endDate: dateField.nullish(),
  })
  .transform(({ startDate, endDate }) => {
    const end = endDate ?? new Date();
    return { startDate: startDate ?? subMonths(end, 3), endDate: end };
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
 * Report pulled by the Hikma Health backoffice: total patients, plus daily
 * counts of patients registered and visits over the requested range.
 */
export const Route = createFileRoute("/api/hh/analytics/report")({
  server: {
    middleware: [authAnalyticsMiddleware],
    handlers: {
      POST: async function ({ request }) {
        const text = await request.text();
        let json: unknown;
        try {
          json = text === "" ? {} : JSON.parse(text);
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const parsed = reportSchema.safeParse(json);
        if (!parsed.success) {
          return new Response(
            JSON.stringify({ error: parsed.error.flatten() }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        const { startDate, endDate } = parsed.data;
        const start = format(startDate, "yyyy-MM-dd");
        const end = format(endDate, "yyyy-MM-dd");

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
