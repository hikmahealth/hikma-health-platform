import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { minutesToMilliseconds } from "date-fns";
import { z } from "zod";
import db from "@/db";
import { createRateLimiter, getClientIp } from "@/lib/rate-limiter";
import {
  checkSetupToken,
  completeSetup,
  normaliseSetupInput,
  validateSetupInput,
} from "@/lib/setup/complete-setup";
import { getDefaultCredentialStatus } from "@/lib/setup/default-credential";
import { adminMiddleware } from "@/middleware/auth";
import { isSetupComplete } from "@/lib/setup/is-setup-complete";
import { announceSetupToken } from "@/lib/setup/setup-token";
import { logAuditEvent } from "@/lib/server-functions/audit";

const setupTokenLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(15),
  maxRequests: 5,
});

export type RateLimited = { kind: "rate-limited"; retryAfterMs: number };

const rateLimit = (): RateLimited | null => {
  const result = setupTokenLimiter.check(`setup:${getClientIp(getRequest())}`);
  return result.allowed
    ? null
    : { kind: "rate-limited", retryAfterMs: result.retryAfterMs };
};

const tokenSchema = z.string().trim().min(1).max(512);
const text = (max: number) => z.string().trim().max(max);

/** Also prints the token while pending, for start paths that skip the boot step. */
export const getSetupStatusFn = createServerFn({ method: "GET" }).handler(
  async () => {
    if (await isSetupComplete()) return { complete: true };
    await announceSetupToken(db);
    return { complete: false };
  },
);

/** Step 1 of the wizard: does this token unlock setup? */
export const checkSetupTokenFn = createServerFn({ method: "POST" })
  .validator(z.object({ token: tokenSchema }))
  .handler(async ({ data }) => rateLimit() ?? checkSetupToken(db, data.token));

/** Final step: create the first super admin and close setup. */
export const completeSetupFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      token: tokenSchema,
      organizationName: text(120),
      clinicName: text(120),
      clinicCountry: text(120),
      clinicCity: text(120),
      adminName: text(120),
      adminEmail: text(254),
      adminPassword: z.string().max(1024),
      acknowledgedDataResponsibility: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    // Rejected input says nothing about the token, so it costs no attempt.
    const problem = validateSetupInput(normaliseSetupInput(data));
    if (problem) return problem;

    const limited = rateLimit();
    if (limited) return limited;

    const outcome = await completeSetup(db, data);
    if (outcome.kind === "completed") {
      await logAuditEvent({
        actionType: "CREATE",
        tableName: "instance_setup",
        rowId: "1",
        changes: {},
        userId: outcome.userId,
        metadata: {
          event: "instance_setup_completed",
          clinic_id: outcome.clinicId,
        },
      });
    }
    return outcome;
  });

/** For the admin portal's warning while the seeded admin keeps its default password. */
export const getDefaultCredentialStatusFn = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async () => getDefaultCredentialStatus(db));
