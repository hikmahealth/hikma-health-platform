import { createFileRoute } from "@tanstack/react-router";
import { minutesToMilliseconds } from "date-fns";
import { Logger } from "@hikmahealth/js-utils";
import {
  createRateLimiter,
  getClientIp,
  tooManyRequestsResponse,
} from "@/lib/rate-limiter";
import Resource from "@/models/resource";
import Patient from "@/models/patient";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import { getConfiguredAdapter } from "@/storage/factory";
import { putVerified } from "@/storage/integrity";
import { RESOURCE_PATH_PREFIX, UPLOAD_SIZE_LIMIT_BYTES } from "@/storage/types";
import {
  authenticateCaller,
  classifyExistingResourceClaim,
  readMultipartCapped,
  sniffFormMimetype,
  isCanonicalUuid,
  sha256Hex,
  logResourceAudit,
  PayloadTooLargeError,
  MalformedMultipartError,
  FORM_UPLOAD_BODY_LIMIT_BYTES,
  type AuthenticatedCaller,
} from "@/lib/form-resources";

const uploadLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(1),
  maxRequests: 60,
});

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

/**
 * A resource id already exists: honour it only as an idempotent replay by the
 * original uploader, otherwise reject without touching the stored resource.
 */
const respondForExistingResource = (
  existing: Resource.Table.Resources,
  caller: AuthenticatedCaller,
  digest: string,
): Response => {
  const verdict = classifyExistingResourceClaim(existing, {
    callerId: caller.id,
    digest,
    expectedSource: Resource.SOURCE.EVENT_FORM,
  });
  if (verdict.outcome === "conflict") {
    return json({ error: "Resource id already in use" }, 409);
  }
  return json({ id: existing.id, mimetype: existing.mimetype }, 200);
};

export const Route = createFileRoute("/api/forms/resources")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request);
        const limit = uploadLimiter.check(ip);
        if (!limit.allowed) return tooManyRequestsResponse(limit.retryAfterMs);

        try {
          const caller = await authenticateCaller(request);
          if (!caller) return json({ error: "Unauthorized" }, 401);

          let form: FormData;
          try {
            form = await readMultipartCapped(
              request,
              FORM_UPLOAD_BODY_LIMIT_BYTES,
            );
          } catch (error) {
            if (error instanceof PayloadTooLargeError) {
              return json({ error: "Upload exceeds size limit" }, 413);
            }
            if (error instanceof MalformedMultipartError) {
              return json({ error: "Malformed multipart request" }, 400);
            }
            throw error;
          }

          const id = String(form.get("id") ?? "");
          const patientId = String(form.get("patient_id") ?? "");
          const clientClinicId = form.get("clinic_id")
            ? String(form.get("clinic_id"))
            : null;
          const file = form.get("file");

          if (!isCanonicalUuid(id)) {
            return json({ error: "Invalid resource id" }, 400);
          }
          if (!isCanonicalUuid(patientId)) {
            return json({ error: "Invalid patient id" }, 400);
          }
          if (!(file instanceof File)) {
            return json({ error: "Missing file" }, 400);
          }

          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.byteLength === 0) {
            return json({ error: "Empty file" }, 400);
          }
          if (bytes.byteLength > UPLOAD_SIZE_LIMIT_BYTES) {
            return json({ error: "Upload exceeds size limit" }, 413);
          }

          const mimetype = sniffFormMimetype(bytes);
          if (mimetype === null) {
            return json({ error: "File type not allowed" }, 415);
          }

          const digest = sha256Hex(bytes);

          const existing = await Resource.getById(id);
          if (existing) {
            return respondForExistingResource(existing, caller, digest);
          }

          // The clinic scope comes from the patient record, not the client-declared
          // clinic, so a caller cannot attach a file to a clinic they can reach for
          // a patient who does not belong to it. The patient/event link itself lives
          // in the event's form_data and is not duplicated onto the resource.
          const scope = await Patient.API.getClinicScope(patientId);
          if (!scope) {
            return json({ error: "Patient not found" }, 400);
          }
          const scopeClinicId = scope.primaryClinicId ?? clientClinicId;
          if (!scopeClinicId) {
            return json({ error: "Unable to determine clinic scope" }, 400);
          }

          const permittedClinicIds =
            await UserClinicPermissions.API.getClinicIdsWithPermission(
              caller.id,
              UserClinicPermissions.userPermissions.CAN_REGISTER_PATIENTS,
            );
          if (!permittedClinicIds.includes(scopeClinicId)) {
            return json({ error: "Unauthorized" }, 403);
          }

          const adapter = await getConfiguredAdapter();
          const destination = `${RESOURCE_PATH_PREFIX}/${id}`;
          await putVerified(adapter, bytes, destination, mimetype);

          const description = file.name ? file.name.slice(0, 255) : null;

          try {
            const inserted = await Resource.insertFormResource({
              id,
              store: adapter.name,
              store_version: adapter.version,
              uri: destination,
              hash: digest,
              mimetype,
              description,
              clinic_id: scopeClinicId,
              created_by_user_id: caller.id,
            });

            try {
              await logResourceAudit(request, {
                actionType: "CREATE",
                resourceId: inserted.id,
                userId: caller.id,
                metadata: { clinic_id: scopeClinicId, source: "event_form" },
              });
            } catch (auditError) {
              Logger.error({
                msg: "[forms.resources] audit write failed on upload",
                error: auditError,
              });
            }

            return json({ id: inserted.id, mimetype }, 201);
          } catch (insertError) {
            // A concurrent request claimed this id between the getById above
            // and the insert. Fall back to idempotent-replay handling.
            const raced = await Resource.getById(id);
            if (raced) return respondForExistingResource(raced, caller, digest);
            throw insertError;
          }
        } catch (error) {
          Logger.error({ msg: "[forms.resources] upload failed", error });
          return json({ error: "Internal server error" }, 500);
        }
      },
    },
  },
});
