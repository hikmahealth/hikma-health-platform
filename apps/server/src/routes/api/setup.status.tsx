import { createFileRoute } from "@tanstack/react-router";
import { isSetupComplete } from "@/lib/setup/is-setup-complete";

/** Public on purpose: reports only whether first-run setup has finished. */
export const Route = createFileRoute("/api/setup/status")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          { complete: await isSetupComplete() },
          { headers: { "Cache-Control": "no-store" } },
        ),
    },
  },
});
