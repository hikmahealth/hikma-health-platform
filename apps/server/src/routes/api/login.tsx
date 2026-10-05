/**
 * Routes to /api/login for older mobile applications that need to sign into
 * the app. Despite the name this is the endpoint the current mobile app still
 * calls (apps/mobile/app/models/User.ts), so it cannot be removed.
 *
 * It differs from /api/auth/sign-in only in response shape: the user fields are
 * flattened alongside the token rather than nested under `user`.
 */

import { createFileRoute } from "@tanstack/react-router";
import { attemptSignIn } from "@/lib/auth/sign-in";
import { tooManyRequestsResponse } from "@/lib/rate-limiter";

export const Route = createFileRoute("/api/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const outcome = await attemptSignIn(request);

        if (outcome.kind === "rate-limited") {
          return tooManyRequestsResponse(outcome.retryAfterMs);
        }

        if (outcome.kind === "invalid") {
          return new Response(
            JSON.stringify({ error: "Invalid credentials" }),
            {
              headers: { "Content-Type": "application/json" },
              status: 401,
            },
          );
        }

        return new Response(
          JSON.stringify({ ...outcome.user, token: outcome.token }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        );
      },
    },
  },
});
