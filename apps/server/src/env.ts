import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// current default path for the HH reporter
const DEFAULT_HIKMA_REPORTER_URL = "https://backoffice.fly.dev";

export const env = createEnv({
  server: {
    SERVER_URL: z.url().optional(),
    HIKMA_REPORTER_URL: z.url().optional().default(DEFAULT_HIKMA_REPORTER_URL),
  },

  /**
   * The prefix that client-side variables must have. This is enforced both at
   * a type-level and at runtime.
   */
  clientPrefix: "VITE_",

  client: {
    VITE_APP_TITLE: z.string().min(1).optional(),
    VITE_HIKMA_REPORTER_URL: z
      .url()
      .optional()
      .default(DEFAULT_HIKMA_REPORTER_URL),
    VITE_SERVER_URL: z.url().optional(),
  },

  /**
   * What object holds the environment variables at runtime. This is usually
   * `process.env` or `import.meta.env`.
   */
  runtimeEnv: import.meta.env,

  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
});
