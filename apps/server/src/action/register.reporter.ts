import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { superAdminMiddleware } from "@/middleware/auth";

//** create here

export const registerReporter = createServerFn({ method: "POST" })
  .validator(
    z.object({
      client_id: z.string(),
    }),
  )
  .middleware([superAdminMiddleware])
  .handler(async function () {
    // generates the private key with the client data shared
  });
