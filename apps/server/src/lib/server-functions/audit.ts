/**
 * Audit logging helpers for server functions.
 * Provides a lightweight way to get request context and log events
 * from within createServerFn handlers.
 */

import { createHash } from "crypto";
import { isIP } from "node:net";
import * as Sentry from "@sentry/tanstackstart-react";
import db from "@/db";
import EventLog from "@/models/event-logs";
import { getRequestHeader } from "@tanstack/react-start/server";
import { Logger } from "@hikmahealth/js-utils";

/**
 * Build an EventLog.RequestContext from the current server function request.
 * Uses TanStack's getRequestHeader() which works inside createServerFn handlers.
 */
export function getWebRequestContext(): EventLog.RequestContext {
  let ipAddress: string | null = null;
  let deviceId = "unknown";

  try {
    const forwarded = getRequestHeader("x-forwarded-for");
    const first =
      typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : null;
    // A client-sent non-IP would fail the inet insert and drop the row.
    ipAddress = first && isIP(first) ? first : null;

    const userAgent = getRequestHeader("user-agent") ?? "unknown";
    deviceId = createHash("sha256").update(userAgent).digest("hex");
  } catch {
    // getRequestHeader may throw if called outside a request context (e.g. in tests)
  }

  return {
    ipAddress,
    deviceId,
    appId: "web",
  };
}

/**
 * Log a single audit event using the shared db instance and web request context.
 * Fire-and-forget — errors are caught and logged, never thrown to the caller.
 */
export async function logAuditEvent(
  params: EventLog.LogEventParams,
): Promise<void> {
  try {
    const ctx = getWebRequestContext();
    await EventLog.logEvent(db, params, ctx);
  } catch (error) {
    // Audit logging should never break the primary operation
    Sentry.captureException(error, { tags: { subsystem: "audit" } });
    Logger.error({ msg: "Audit log failed:", error });
  }
}

/** Log a write by the signed-in user; without an actor nothing is recorded. */
export async function logAdminAudit(
  userId: string | null | undefined,
  params: Omit<EventLog.LogEventParams, "userId">,
): Promise<void> {
  if (!userId) return;
  await logAuditEvent({ ...params, userId });
}

/** Names of the fields in `after` whose values differ from `before`. */
export function changedFieldNames(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(after).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}
