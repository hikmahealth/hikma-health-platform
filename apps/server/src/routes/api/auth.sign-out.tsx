import { createFileRoute } from "@tanstack/react-router";
import { deleteCookie, getCookie } from "@tanstack/react-start/server";
import Token from "@/models/token";
import { Logger } from "@hikmahealth/js-utils";
import { recordSignOut, signInClient } from "@/lib/auth/sign-in-audit";

export const Route = createFileRoute("/api/auth/sign-out")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Get token from cookies
        const token = getCookie("token");

        if (!token) {
          return new Response(JSON.stringify({ error: "Not authenticated" }), {
            headers: {
              "Content-Type": "application/json",
            },
            status: 401,
          });
        }

        try {
          const caller = await Token.getUser(token);
          // Invalidate the token in the database
          await Token.invalidate(token);
          deleteCookie("token");
          if (caller._tag === "Some") {
            await recordSignOut(signInClient(request, "web"), caller.value.id);
          }

          return new Response(JSON.stringify({ success: true }), {
            headers: {
              "Content-Type": "application/json",
            },
            status: 200,
          });
        } catch (error) {
          Logger.error({ msg: "Error during sign-out:", error });
          return new Response(JSON.stringify({ error: "Failed to sign out" }), {
            headers: {
              "Content-Type": "application/json",
            },
            status: 500,
          });
        }
      },
    },
  },
});
