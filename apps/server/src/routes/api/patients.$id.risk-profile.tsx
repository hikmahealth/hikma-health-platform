import db from "@/db";
import { createFileRoute } from "@tanstack/react-router";

export type RiskPrediction = {
  value: {
    score: "low" | "medium" | "high";
    type: "cvd" | "respiratory";
  };
  /** ISO timestamp string — Dates become strings after JSON serialization. */
  recorded_at: string | null;
};

export const Route = createFileRoute("/api/patients/$id/risk-profile")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { id: patientId } = params;

        const rows = await db
          .selectFrom("patient_risk_profiles")
          .select(["string_value", "updated_at"])
          .where("patient_id", "=", patientId)
          .where("profile_key", "=", "risk_prediction")
          .where("is_deleted", "=", false)
          .execute();

        const predictions: RiskPrediction[] = rows.map((row) => ({
          value: JSON.parse(
            row.string_value as string,
          ) as RiskPrediction["value"],
          recorded_at: row.updated_at,
        }));

        console.log({ predictions, params });

        return new Response(JSON.stringify(predictions), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        });
      },
    },
  },
});
