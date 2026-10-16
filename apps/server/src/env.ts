import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    SERVER_URL: z.url().optional(),
  },

  // enforced at both the type level and runtime
  clientPrefix: "VITE_",

  client: {
    VITE_APP_TITLE: z.string().min(1).optional(),
  },

  runtimeEnv: import.meta.env,

  // otherwise `KEY=` in a .env fails number parsing and skips defaults
  emptyStringAsUndefined: true,
});
