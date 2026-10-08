import { createFileRoute } from "@tanstack/react-router";
import { getCookie, deleteCookie } from "@tanstack/react-start/server";
import Token from "@/models/token";
import { Option } from "effect";
import { getCookieToken } from "@/lib/auth/request";
import { Logger } from "@hikmahealth/js-utils";

export const Route = createFileRoute("/api/auth/is-valid-token")({
  server: {
    handlers: {
      POST: async ({}) => {
        Logger.log("here");
        const token = Option.fromNullable(getCookie("token"));
        // const token = getCookieToken()

        return Option.match(token, {
          onNone: () => {
            Logger.log("No token found, deleting cookie");
            deleteCookie("token");
            return new Response(JSON.stringify({ isValid: false }), {
              headers: {
                "Content-Type": "application/json",
              },
              status: 401,
            });
          },
          onSome: async (token) => {
            const user = await Token.getUser(token);
            const isValid = Option.isSome(user);
            if (!isValid) {
              Logger.log("Invalid token, deleting cookie");
              deleteCookie("token");
            }
            return new Response(JSON.stringify({ isValid }), {
              headers: {
                "Content-Type": "application/json",
              },
              status: 200,
            });
          },
        });
      },
      GET: async () => {
        Logger.log("trying to define get");
        return new Response("there are no get endpoints");
      },
    },
  },
});
