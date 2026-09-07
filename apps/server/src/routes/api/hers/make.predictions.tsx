import { hersclient, serverUrl } from "@/clients/base";
import db from "@/db";
import { createFileRoute } from "@tanstack/react-router";
import { subDays } from "date-fns";
import { uuidv7 } from "uuidv7";
export const Route = createFileRoute("/api/hers/make/predictions")({
  server: {
    handlers: {
      POST: async ({ request }) => {},
    },
  },
});
