import { createServerFn } from "@tanstack/react-start";
import AccessGrant from "@/models/access-grant";
import { superAdminMiddleware } from "@/middleware/auth";
import { logAuditEvent } from "@/lib/server-functions/audit";
import {
  ACCESS_GRANT_QUERY_PARAM,
  ACCESS_GRANT_SCOPES,
} from "@/lib/access-grant-scopes";

/**
 * Grants backing the attachment links in a downloaded patient data export.
 *
 * Kept out of the route component because `AccessGrant` reaches `node:crypto`,
 * which the browser build cannot externalize. Routes import these wrappers and
 * `lib/access-grant-scopes`, never the model.
 */

const SCOPE = ACCESS_GRANT_SCOPES.EVENT_FORM_ATTACHMENTS_READ;

export type ExportAccessGrantSummary = {
  id: string;
  createdAt: string;
  expiresAt: string;
};

/** superAdminMiddleware has already rejected anyone without a session. */
const callerId = (context: { userId: string | null }): string => {
  if (!context.userId) throw new Error("Unauthorized");
  return context.userId;
};

/** One grant per export, not one per file, so a single revocation kills a leaked workbook. */
export const createAttachmentExportGrant = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator((data: { expiryDays: number }) => data)
  .handler(async ({ data, context }) => {
    const userId = callerId(context);

    const grant = await AccessGrant.mint({
      scope: SCOPE,
      userId,
      expiryDays: data.expiryDays,
      description: "Patient data export attachment links",
    });

    await logAuditEvent({
      actionType: "EXPORT",
      tableName: "access_grants",
      rowId: grant.id,
      changes: {},
      userId,
      metadata: { scope: SCOPE, expires_at: grant.expiresAt.toISOString() },
    });

    return {
      token: grant.token,
      tokenParam: ACCESS_GRANT_QUERY_PARAM,
      expiresAt: grant.expiresAt.toISOString(),
    };
  });

export const listAttachmentExportGrants = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async ({ context }): Promise<ExportAccessGrantSummary[]> => {
    const grants = await AccessGrant.listLiveForUser(callerId(context));
    return grants
      .filter((grant) => grant.scope === SCOPE)
      .map((grant) => ({
        id: grant.id,
        createdAt: grant.created_at.toISOString(),
        expiresAt: grant.expires_at.toISOString(),
      }));
  });

/**
 * Break every link in one exported workbook. Restricted to grants the caller
 * minted, so it needs no authorization model of its own.
 */
export const revokeAttachmentExportGrant = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator((data: { grantId: string }) => data)
  .handler(async ({ data, context }) => {
    const userId = callerId(context);

    const owned = await AccessGrant.listLiveForUser(userId);
    const grant = owned.find((candidate) => candidate.id === data.grantId);
    if (!grant || grant.scope !== SCOPE) {
      throw new Error("Not found");
    }

    await AccessGrant.revoke(grant.id);
    await logAuditEvent({
      actionType: "UPDATE",
      tableName: "access_grants",
      rowId: grant.id,
      changes: {},
      userId,
      metadata: { scope: SCOPE, revoked: true },
    });
  });
