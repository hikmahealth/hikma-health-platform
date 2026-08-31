import db from "@/db";
import { env } from "@/env";
import { getHersClient } from "@/hers.node";
import { JURL } from "@/hers.node/utils";
import { createFileRoute } from "@tanstack/react-router";

// TODO: replace this location with values that's replaced on the `clinic` record
// might want to use string so as to not lose precision
//
// This should come from the database "clinic"
const locationToListen = ["25.795592", "-80.196705"] as const;

export const hersclient = getHersClient();

if (!process.env.SERVER_URL) {
  throw new Error("missing SERVER_URL from environment variables");
}

// NOTE(@ally): how is this loaded onto the server dynamically?
export const serverUrl = new JURL(process.env.SERVER_URL);

export const Route = createFileRoute("/api/hers/subscription")({
  server: {
    handlers: {
      GET: async function () {
        // get all the clinics that have subscribed to some environmental changes
        return { clinics: [] as string[] };
      },
      POST: async function ({ request }) {
        // select the clinic to subscribe
        const input = (await request.json()) as {
          clinic_id: string;
        };

        const clinic = await db
          .selectFrom("clinics")
          .select(["clinics.id"])
          .where("clinics.id", "=", input.clinic_id)
          .where("clinics.is_deleted", "=", false)
          .executeTakeFirst();

        if (!clinic) {
          throw new Response("no such clinic", { status: 404 });
        }

        // send
        const res = await fetch(
          hersclient.baseurl.joinPath(
            "/v1/api/subscription/environmental-changes",
          ),
          {
            method: "POST",
            headers: hersclient.createHeader(),
            body: JSON.stringify({
              location: {
                reference: clinic.id,
                latitude: locationToListen[0],
                longitude: locationToListen[1],
              },
              webhook: serverUrl
                .joinPath("/api/hers/environment/notify")
                .toString(),
            }),
          },
        );

        if (!res.ok) {
          throw new Response(
            "failed to add clinic to listen to environment changes",
            { status: 500 },
          );
        }

        return new Response("done!", { status: 202 });
      },
    },
  },
});
