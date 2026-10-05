import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

//** create here

export const registerReporter = createServerFn({ method: "POST" })
  .validator(
    z.object({
      client_id: z.string(),
    }),
  )
  .handler(async function () {
    // generates the private key with the client data shared
  });
