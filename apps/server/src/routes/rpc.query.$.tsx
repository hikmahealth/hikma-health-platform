import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { queryAppRouter } from "@/integrations/trpc/router";
import { createTRPCContext } from "@/integrations/trpc/init";
import { tooManyRequestsResponse } from "@/lib/rate-limiter";
import { isBackfillOnly, checkBackfillLimit } from "@/lib/rpc-rate-limit";
import { rejectWhileSetupPending } from "@/lib/setup/setup-gate";

const ENDPOINT = "/rpc/query";

/**
 * A ceiling on the paged backfill only. Every other query procedure on this
 * route is unlimited, as it was before — this adds a bound where there was
 * none rather than tightening an existing one.
 *
 * `checkBackfillLimit` keys the ceiling on the caller so a clinic behind one
 * NAT does not starve itself, under a much higher per-IP backstop so an
 * unauthenticated caller cannot rotate bearer tokens to mint fresh buckets.
 * In-memory and per-process: on a multi-instance deploy the effective ceilings
 * are those numbers times the instance count.
 */
async function handler({ request }: { request: Request }) {
  const setupRequired = await rejectWhileSetupPending();
  if (setupRequired) return setupRequired;

  const pathname = new URL(request.url).pathname;
  if (isBackfillOnly(pathname, ENDPOINT)) {
    const limit = checkBackfillLimit(request);
    if (!limit.allowed) return tooManyRequestsResponse(limit.retryAfterMs);
  }

  return fetchRequestHandler({
    req: request,
    router: queryAppRouter,
    endpoint: "/rpc/query",
    createContext: () => createTRPCContext(request),
  });
}

export const Route = createFileRoute("/rpc/query/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
