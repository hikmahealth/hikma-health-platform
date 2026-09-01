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

type DateString = string;

type Value =
  string | number | boolean | null | Value[] | { [k: string]: Value };
const json = <T extends Value>(data: T, options?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    status: 200,
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });

export const Route = createFileRoute("/api/hers/subscription")({
  server: {
    handlers: {
      GET: async function () {
        // might to cache this clinic
        const res = await fetch(
          hersclient.baseurl.joinPath(
            "/v1/api/subscription/environmental-changes",
          ),
          {
            method: "GET",
            headers: hersclient.createHeader(),
          },
        );

        if (!res.ok) {
          throw new Error(
            "failed to return provide the values" + res.statusText,
          );
        }

        const data = (await res.json()) as Array<{
          reference: string;
          description?: string | null;
          webhook_url: string;
          subscribed_at: DateString;
        }>;

        if (data.length === 0) {
          return json({ clinics: [] });
        }

        // return list of present clinics that have subscribed to the service
        const subbedclinics = await db
          .selectFrom("clinics")
          .select(["clinics.id"])
          .where(
            "clinics.id",
            "in",
            data.map((s) => s.reference),
          )
          .where("clinics.is_deleted", "=", false)
          .execute();

        // get all the clinics that have subscribed to some environmental changes
        return json({ clinics: subbedclinics.map((s) => s.id) });
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
            headers: hersclient.createHeader({
              "Content-Type": "application/json",
            }),
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
            "failed to add clinic to listen to environment changes. reason:" +
              (await res.text()),
            { status: 500 },
          );
        }

        return json("done!", { status: 202 });
      },
      DELETE: async function ({ request }) {
        const input = (await request.json()) as { clinic_id: string };

        // Build the delete URL with the clinic ID as the location reference
        const deleteUrl = hersclient.baseurl.joinPath(
          "/v1/api/subscription/environmental-changes",
        );
        deleteUrl.searchParams.set("location", input.clinic_id);

        const res = await fetch(deleteUrl.toString(), {
          method: "DELETE",
          headers: hersclient.createHeader(),
        });

        if (!res.ok) {
          throw new Response(
            "failed to remove clinic from HERS subscriptions. reason:" +
              (await res.text()),
            { status: 500 },
          );
        }

        return json("done!", { status: 200 });
      },
    },
  },
});
