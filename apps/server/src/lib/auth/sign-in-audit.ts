import { createHash } from "node:crypto";
import { isIP } from "node:net";
import * as Sentry from "@sentry/tanstackstart-react";
import { Logger } from "@hikmahealth/js-utils";
import db from "@/db";
import EventLog from "@/models/event-logs";

/** Where a sign-in arrived: the admin portal, the mobile REST login, or tRPC. */
export type SignInChannel = "web" | "mobile" | "rpc";

export type SignInClient = {
  channel: SignInChannel;
  ipAddress: string | null;
  userAgent: string | null;
};

/** Devices sign in before every sync, which is already audited; failures are always recorded. */
export const RECORD_DEVICE_SIGN_IN_SUCCESS = false;

const UNAUTHENTICATED = "unauthenticated";

// event_logs rows can never be deleted, so a flood of rate-limited requests
// must not become a flood of rows: one row per limiter key per window.
const RATE_LIMITED_KEYS_MAX = 10_000;
const rateLimitedUntil = new Map<string, number>();

// Unknown-email failures skip bcrypt and evade the header-keyed limiters, so
// they get a budget per window; dropped rows are counted on the next one.
export const UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW = 100;
const UNKNOWN_ACCOUNT_WINDOW_MS = 60_000;
const unknownAccountFailures = { windowStart: 0, recorded: 0, suppressed: 0 };

/** The suppressed count to report, or null when this row is over budget. */
const takeUnknownAccountBudget = (): number | null => {
  const now = Date.now();
  if (now - unknownAccountFailures.windowStart >= UNKNOWN_ACCOUNT_WINDOW_MS) {
    unknownAccountFailures.windowStart = now;
    unknownAccountFailures.recorded = 0;
  }
  if (unknownAccountFailures.recorded >= UNKNOWN_ACCOUNT_FAILURES_PER_WINDOW) {
    unknownAccountFailures.suppressed++;
    return null;
  }
  unknownAccountFailures.recorded++;
  const suppressed = unknownAccountFailures.suppressed;
  unknownAccountFailures.suppressed = 0;
  return suppressed;
};

export const signInClient = (
  request: Request,
  channel: SignInChannel,
): SignInClient => {
  const forwarded = request.headers.get("x-forwarded-for");
  return {
    channel,
    ipAddress: forwarded ? (forwarded.split(",")[0]?.trim() ?? null) : null,
    userAgent: request.headers.get("user-agent"),
  };
};

type SignInEvent = {
  actionType: "SIGN_IN" | "SIGN_IN_FAILED" | "SIGN_OUT";
  userId: string;
  metadata: Record<string, unknown>;
};

const record = async (client: SignInClient, event: SignInEvent) => {
  try {
    await EventLog.logEvent(
      db as unknown as Parameters<typeof EventLog.logEvent>[0],
      {
        actionType: event.actionType,
        tableName: "users",
        rowId: event.userId,
        changes: {},
        userId: event.userId,
        metadata: event.metadata,
      },
      {
        // The column is inet, so anything else would fail the insert.
        ipAddress:
          client.ipAddress && isIP(client.ipAddress) ? client.ipAddress : null,
        deviceId: createHash("sha256")
          .update(client.userAgent ?? "unknown")
          .digest("hex"),
        appId: client.channel,
      },
    );
  } catch (error) {
    Sentry.captureException(error, { tags: { subsystem: "audit" } });
    Logger.error({ msg: "[sign-in-audit] failed to record", error });
  }
};

/**
 * The live account an email belongs to, matched as sign-in matches it. What was
 * typed is never stored: people type passwords into the email field.
 */
const findAccount = async (
  email: unknown,
): Promise<{ id: string; email: string } | null> => {
  if (typeof email !== "string" || email.length === 0) return null;
  const user = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("email", "=", email)
    .where("is_deleted", "=", false)
    .executeTakeFirst();
  return user ?? null;
};

const accountMetadata = (account: { email: string } | null) =>
  account ? { email: account.email } : { account_found: false };

export async function recordSignInSuccess(
  client: SignInClient,
  userId: string,
): Promise<void> {
  if (client.channel !== "web" && !RECORD_DEVICE_SIGN_IN_SUCCESS) return;
  await record(client, {
    actionType: "SIGN_IN",
    userId,
    metadata: { channel: client.channel },
  });
}

export async function recordSignInFailure(
  client: SignInClient,
  email: unknown,
): Promise<void> {
  try {
    const account = await findAccount(email);
    const suppressed = account ? 0 : takeUnknownAccountBudget();
    if (suppressed === null) return;
    await record(client, {
      actionType: "SIGN_IN_FAILED",
      userId: account?.id ?? UNAUTHENTICATED,
      metadata: {
        channel: client.channel,
        reason: "invalid-credentials",
        ...accountMetadata(account),
        ...(suppressed > 0 ? { suppressed_before: suppressed } : {}),
      },
    });
  } catch (error) {
    Logger.error({ msg: "[sign-in-audit] failed to record failure", error });
  }
}

/** True the first time `key` is seen in its window, false for repeats. */
const isFirstInWindow = (key: string, retryAfterMs: number): boolean => {
  const now = Date.now();
  const until = rateLimitedUntil.get(key);
  if (until !== undefined && until > now) return false;

  if (rateLimitedUntil.size >= RATE_LIMITED_KEYS_MAX) {
    for (const [stored, expiry] of rateLimitedUntil) {
      if (expiry <= now) rateLimitedUntil.delete(stored);
    }
    if (rateLimitedUntil.size >= RATE_LIMITED_KEYS_MAX) return false;
  }
  rateLimitedUntil.set(key, now + retryAfterMs);
  return true;
};

export async function recordSignInRateLimited(
  client: SignInClient,
  limit: {
    scope: "ip" | "account";
    key: string;
    retryAfterMs: number;
    email?: unknown;
  },
): Promise<void> {
  if (!isFirstInWindow(limit.key, limit.retryAfterMs)) return;
  try {
    const account =
      limit.scope === "account" ? await findAccount(limit.email) : null;
    await record(client, {
      actionType: "SIGN_IN_FAILED",
      userId: account?.id ?? UNAUTHENTICATED,
      metadata: {
        channel: client.channel,
        reason: "rate-limited",
        limit_scope: limit.scope,
        retry_after_ms: limit.retryAfterMs,
        ...(limit.scope === "account" ? accountMetadata(account) : {}),
      },
    });
  } catch (error) {
    Logger.error({ msg: "[sign-in-audit] failed to record limit", error });
  }
}

export async function recordSignOut(
  client: SignInClient,
  userId: string,
): Promise<void> {
  await record(client, {
    actionType: "SIGN_OUT",
    userId,
    metadata: { channel: client.channel },
  });
}

/** Test seam: forget every per-process counter. */
export const resetSignInAuditState = (): void => {
  rateLimitedUntil.clear();
  unknownAccountFailures.windowStart = 0;
  unknownAccountFailures.recorded = 0;
  unknownAccountFailures.suppressed = 0;
};
