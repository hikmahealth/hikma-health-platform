import db from "@/db";
import { createFileRoute } from "@tanstack/react-router";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";

export const Route = createFileRoute("/api/hers/output/prediction")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // .... after getting the data, write this to
        const input = (await request.json()) as {
          id: string;
          results: Array<
            [
              id: string,
              Array<{
                score: number;
                level: "low" | "high" | "medium";
                type: "cvd" | "respiratory";
              }>,
            ]
          >;
        };

        const batch = [];

        // use this information to write to patient additional attributes
        for (const [id, _data] of input.results) {
          // get the high score that best reflects the patient's risk
          batch.push({
            id: uuidv7(),
            attribute_id: uuidv7(),
            patient_id: id,
            attribute: "patient_chart_data",
            unique_reference: "risk_profile_notification",
            string_value: JSON.stringify({
              text: "This is a serious note",
              level: "high",
              profile: "cvd",
            }),
            is_deleted: false,
            deleted_at: null,
            created_at: sql`now()`,
            updated_at: sql`now()`,
          });
        }

        await db
          .insertInto("patient_additional_attributes")
          .values(batch)
          .onConflict((eb) =>
            eb.columns(["patient_id", "unique_reference"]).doUpdateSet((eb) => {
              return {
                string_value: eb.ref("excluded.string_value"),
                is_deleted: false,
                deleted_at: null,
                updated_at: eb.ref("excluded.updated_at"),
              };
            }),
          )
          .execute();
      },
    },
  },
});
