import { createFileRoute } from "@tanstack/react-router";
import { attemptSignIn } from "@/lib/auth/sign-in";
import { tooManyRequestsResponse } from "@/lib/rate-limiter";
import { rejectWhileSetupPending } from "@/lib/setup/setup-gate";

export const Route = createFileRoute("/api/auth/sign-in")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const setupRequired = await rejectWhileSetupPending();
        if (setupRequired) return setupRequired;

        const outcome = await attemptSignIn(request, "web");

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
          JSON.stringify({ user: outcome.user, token: outcome.token }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        );
      },
    },
  },
});
