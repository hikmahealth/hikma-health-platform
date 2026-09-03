import db from "@/db";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";

type DateString = string;

export const Route = createFileRoute("/api/hers/output/prediction")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const input = (await request.json()) as {
          generated_at: DateString;
          metadata?: Record<string, string>;
          results: Array<
            [
              id: string,
              Array<{
                score: "low" | "high" | "medium";
                type: "cvd" | "respiratory";
              }>,
            ]
          >;
        };

        const batch = [];

        for (const [patientId, results] of input.results) {
          for (const result of results) {
            batch.push({
              id: uuidv7(),
              patient_id: patientId,
              kind: "risk_prediction",
              target: result.type,
              value_type: "json" as const,
              json_value: {
                score: result.score,
                type: result.type,
              },
              source: "hers",
              version: "hers-dev",
              is_deleted: false,
              deleted_at: null,
              created_at: sql`now()`,
              updated_at: sql`now()`,
              last_modified: sql`now()`,
              server_created_at: sql`now()`,
            });
          }
        }

        if (batch.length > 0) {
          await db.insertInto("patient_risk_profiles").values(batch).execute();
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
    },
  },
});
