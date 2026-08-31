import db from "@/db";
import { createFileRoute } from "@tanstack/react-router";
import { hersclient, serverUrl } from "./hers.subscription";
import { subDays } from "date-fns";
import { uuidv7 } from "uuidv7";

/**
 * This endpoint is being invoked by HERS
 * Passes digest that can be verified to ensure that this is coming from HERS.
 */
export const Route = createFileRoute("/api/hers/environment/notify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const input = (await request.json()) as { location_reference: string };

        // check if location exists
        const clinic = await db
          .selectFrom("clinics")
          .select(["id"])
          .where("clinics.id", "=", input.location_reference)
          .where("clinics.is_deleted", "=", false)
          .executeTakeFirst();

        if (!clinic) {
          return new Response("no such clinic, ignoring request", {
            status: 208,
          });
        }

        // fetching the list of patients
        // to construct the payload
        const patients = await db
          .selectFrom("patients")
          .select(["sex", "date_of_birth", "id"])
          .where("patients.primary_clinic_id", "=", clinic.id)
          .execute();

        const input_payload = [];
        for (const p of patients) {
          input_payload.push({
            id: p.id,
          });
        }

        const url = hersclient.baseurl.joinPath("/v1/api/compute/risk");
        const q = new URLSearchParams();

        q.set("id", uuidv7());
        q.set(
          "on_complete",
          serverUrl.joinPath("/api/hers/output/prediction").toString(),
        );
        const BIN_WINDOW_DAYS = 30; // this should also reflect the shape of the features in the data
        const end_date = new Date();
        const start_date = subDays(end_date, BIN_WINDOW_DAYS);
        q.set("start_date", start_date.toISOString());
        q.set("end_date", end_date.toISOString());
        q.set("data_bins", BIN_WINDOW_DAYS.toString());

        // construct input
        url.search = q.toString();
        const res = await fetch(url, {
          method: "POST",
          headers: hersclient.createHeader(),
          body: JSON.stringify(input_payload),
        });

        if (!res.ok) {
          throw new Response("failed to request risk compute", { status: 500 });
        }
      },
    },
  },
});
