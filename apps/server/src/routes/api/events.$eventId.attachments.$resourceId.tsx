import { createFileRoute } from "@tanstack/react-router";
import { minutesToMilliseconds } from "date-fns";
import { Logger } from "@hikmahealth/js-utils";
import {
  createRateLimiter,
  getClientIp,
  tooManyRequestsResponse,
} from "@/lib/rate-limiter";
import Resource from "@/models/resource";
import Event from "@/models/event";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import { callerHasClinicPermission } from "@/lib/mobile-permissions";
import { getAdapterForStore } from "@/storage/factory";
import { ResourceStoreUnavailableError } from "@/storage/errors";
import { isStoreType } from "@/storage/types";
import AccessGrant from "@/models/access-grant";
import {
  authenticateCaller,
  eventReferencesResource,
  isCanonicalUuid,
  logResourceAudit,
  resolveGrantedCaller,
} from "@/lib/form-resources";

const downloadLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(1),
  maxRequests: 120,
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

/**
 * Serve an event-form file attachment through its owning event. The event is
 * the aggregate that ties the resource to a patient, so a caller may only read
 * a resource by naming an event that actually references it. `clinic_id` on the
 * resource is the clinic-level guard on top of that.
 *
 * Every negative case returns 404 so the endpoint never confirms whether a
 * given event or resource id exists.
 *
 * A caller with no session may present an access-grant token instead, which is
 * how links in an exported workbook resolve. The grant supplies only an identity
 * and never gets the admin permissions override.
 */
export const Route = createFileRoute(
  "/api/events/$eventId/attachments/$resourceId",
)({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const ip = getClientIp(request);
        const limit = downloadLimiter.check(ip);
        if (!limit.allowed) return tooManyRequestsResponse(limit.retryAfterMs);

        try {
          if (
            !isCanonicalUuid(params.eventId) ||
            !isCanonicalUuid(params.resourceId)
          ) {
            return json({ error: "Not found" }, 404);
          }

          // Session wins over token, so a logged-in user is audited as themselves.
          const session = await authenticateCaller(request);
          const granted = session
            ? null
            : await resolveGrantedCaller(request, {
                scope: AccessGrant.SCOPES.EVENT_FORM_ATTACHMENTS_READ,
                subjectId: params.eventId,
              });
          const caller = session ?? granted;
          if (!caller) return json({ error: "Unauthorized" }, 401);

          const formData = await Event.API.getFormDataById(params.eventId);
          if (!formData) {
            return json({ error: "Not found" }, 404);
          }
          if (!eventReferencesResource(formData, params.resourceId)) {
            return json({ error: "Not found" }, 404);
          }

          const resource = await Resource.getById(params.resourceId);
          if (!resource || resource.source !== Resource.SOURCE.EVENT_FORM) {
            return json({ error: "Not found" }, 404);
          }

          // Clinic-level guard, checked per request so revoking a user's clinic
          // access immediately revokes their ability to read its attachments.
          if (!resource.clinic_id) {
            return json({ error: "Not found" }, 404);
          }

          // Session callers only: a grant token rides inside an exported file,
          // so extending the override there would make every link unrestricted.
          const permitted = await callerHasClinicPermission({
            userId: caller.id,
            clinicId: resource.clinic_id,
            permission: UserClinicPermissions.userPermissions.CAN_VIEW_HISTORY,
            allowMobileOverride: session !== null,
          });
          if (!permitted) {
            return json({ error: "Not found" }, 404);
          }

          // Fail closed: PHI is not served unless the access is recorded.
          try {
            await logResourceAudit(request, {
              actionType: "VIEW",
              resourceId: resource.id,
              userId: caller.id,
              metadata: {
                clinic_id: resource.clinic_id,
                event_id: params.eventId,
                // Traces an exported-link read back to a revocable grant.
                access_grant_id: granted?.grantId ?? null,
              },
            });
          } catch (auditError) {
            Logger.error({
              msg: "[events.attachments] audit write failed, refusing to serve",
              error: auditError,
            });
            return json({ error: "Service unavailable" }, 503);
          }

          // Read from the backend the resource was written to, not the active
          // one, so switching backends never orphans older attachments.
          if (!isStoreType(resource.store)) {
            Logger.error({
              msg: "[events.attachments] resource names an unknown storage backend",
              resourceId: resource.id,
              store: resource.store,
            });
            return json({ error: "Internal server error" }, 500);
          }

          const adapter = await getAdapterForStore(resource.store);
          const bytes = await adapter.downloadAsBytes(resource.uri);

          return new Response(bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": resource.mimetype,
              "Cache-Control": "no-store, private",
              "Content-Disposition": "inline",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          if (error instanceof ResourceStoreUnavailableError) {
            Logger.error({
              msg: "[events.attachments] storage backend unavailable",
              store: error.store,
              error,
            });
            return json({ error: "Storage backend unavailable" }, 503);
          }
          Logger.error({ msg: "[events.attachments] download failed", error });
          return json({ error: "Internal server error" }, 500);
        }
      },
    },
  },
});
