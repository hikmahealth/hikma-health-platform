import { createMiddleware } from "@tanstack/react-start";
import { readCredentials } from "@/lib/analytics-reporting/credentials";
import { verifyPullToken } from "@/lib/analytics-reporting/token";

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

/** Authenticates backoffice pulls by their signed bearer token. */
export const authAnalyticsMiddleware = createMiddleware().server(
  async function ({ request, next }) {
    const header = request.headers.get("Authorization");
    if (!header || !header.startsWith("Bearer ")) return unauthorized();

    try {
      const credentials = await readCredentials();
      if (!credentials) {
        console.warn("analytics auth failed: no reporting credentials registered");
        return unauthorized();
      }
      // clone so the handler can still read the body
      const body = await request.clone().text();
      const result = verifyPullToken(header.substring(7), body, credentials);
      if (!result.ok) {
        console.warn("analytics auth failed:", result.reason);
        return unauthorized();
      }
    } catch (error) {
      console.warn(
        "analytics auth failed:",
        error instanceof Error ? error.message : error,
      );
      return unauthorized();
    }

    return next();
  },
);
