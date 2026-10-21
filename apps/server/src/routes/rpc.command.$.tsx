import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { commandAppRouter } from "@/integrations/trpc/router";
import { createTRPCContext } from "@/integrations/trpc/init";
import {
  createRateLimiter,
  getClientIp,
  tooManyRequestsResponse,
} from "@/lib/rate-limiter";
import { isBackfillOnly, checkBackfillLimit } from "@/lib/rpc-rate-limit";
import { minutesToMilliseconds } from "date-fns";
import { rejectWhileSetupPending } from "@/lib/setup/setup-gate";

const ENDPOINT = "/rpc/command";

const rpcLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(1),
  maxRequests: 100,
});

/**
 * A full backfill is thousands of sequential pages from one device, and the
 * shared 100/min ceiling above is keyed on the IP — so a clinic behind a single
 * NAT would starve not just its own restore but every other command for
 * everyone on that connection. `checkBackfillLimit` keys the ceiling on the
 * caller instead, under a much higher per-IP backstop that bounds an
 * unauthenticated caller rotating bearer tokens to mint fresh buckets.
 *
 * In-memory and per-process, like every limiter here: on a multi-instance
 * deploy the effective ceiling is these numbers times the instance count.
 */
async function handler({ request }: { request: Request }) {
  const setupRequired = await rejectWhileSetupPending();
  if (setupRequired) return setupRequired;

  const pathname = new URL(request.url).pathname;
  const limit = isBackfillOnly(pathname, ENDPOINT)
    ? checkBackfillLimit(request)
    : rpcLimiter.check(getClientIp(request));
  if (!limit.allowed) return tooManyRequestsResponse(limit.retryAfterMs);

  return fetchRequestHandler({
    req: request,
    router: commandAppRouter,
    endpoint: "/rpc/command",
    createContext: () => createTRPCContext(request),
  });
}

export const Route = createFileRoute("/rpc/command/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
