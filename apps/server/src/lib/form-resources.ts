import { createHash } from "node:crypto";
import { Option } from "effect";
import { createServerOnlyFn } from "@tanstack/react-start";
import db from "@/db";
import User from "@/models/user";
import Token from "@/models/token";
import EventLog from "@/models/event-logs";
import AccessGrant from "@/models/access-grant";
import { ACCESS_GRANT_QUERY_PARAM } from "@/lib/access-grant-scopes";

/**
 * Deliberately stricter than the global storage allowlist, which also permits
 * svg, audio and video — svg in particular can carry script.
 */
export const FORM_RESOURCE_MIMETYPES = {
  PNG: "image/png",
  JPEG: "image/jpeg",
  PDF: "application/pdf",
} as const;

export type FormResourceMimetype =
  (typeof FORM_RESOURCE_MIMETYPES)[keyof typeof FORM_RESOURCE_MIMETYPES];

/**
 * Hard ceiling on the multipart request body. The extracted file is
 * additionally re-checked against UPLOAD_SIZE_LIMIT_BYTES; the extra headroom
 * covers multipart boundaries and the small text fields.
 */
export const FORM_UPLOAD_BODY_LIMIT_BYTES = 50 * 1024 * 1024 + 64 * 1024;

/** Canonical lowercase UUID (versions 1–8, RFC-4122 variant). */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isCanonicalUuid = (value: string): boolean =>
  UUID_PATTERN.test(value);

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Upload exceeds size limit");
    this.name = "PayloadTooLargeError";
  }
}

export class MalformedMultipartError extends Error {
  constructor(cause?: unknown) {
    super("Request body is not valid multipart/form-data");
    this.name = "MalformedMultipartError";
    this.cause = cause;
  }
}

export const sha256Hex = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * Whether an event's form_data references a given resource id. A file field's
 * answer stores the resource id as its `value` (an array for multi-file
 * fields). This gates event-mediated downloads: a caller who can reach an event
 * may only read the resources that event actually references.
 */
export const eventReferencesResource = (
  formData: ReadonlyArray<Record<string, unknown>>,
  resourceId: string,
): boolean =>
  formData.some((item) => {
    const value = item?.value;
    if (typeof value === "string") return value === resourceId;
    if (Array.isArray(value)) return value.includes(resourceId);
    return false;
  });

const startsWith = (
  data: Uint8Array,
  signature: readonly number[],
): boolean => {
  if (data.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (data[i] !== signature[i]) return false;
  }
  return true;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * Determine the true content type from the leading bytes, ignoring the
 * client-declared mimetype. Returns null for anything outside the accepted set.
 */
export const sniffFormMimetype = (
  data: Uint8Array,
): FormResourceMimetype | null => {
  if (startsWith(data, PNG_SIGNATURE)) return FORM_RESOURCE_MIMETYPES.PNG;
  if (startsWith(data, JPEG_SIGNATURE)) return FORM_RESOURCE_MIMETYPES.JPEG;
  if (startsWith(data, PDF_SIGNATURE)) return FORM_RESOURCE_MIMETYPES.PDF;
  return null;
};

const concatChunks = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * Read a multipart body, enforcing the byte cap *during* the read so an oversized
 * (or Content-Length-spoofed) body is rejected before it is fully materialised.
 * Throws PayloadTooLargeError once the cap is crossed.
 */
export const readMultipartCapped = async (
  request: Request,
  maxBytes: number,
): Promise<FormData> => {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    throw new PayloadTooLargeError();
  }

  const body = request.body;
  if (body === null) {
    return new FormData();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const buffer = concatChunks(chunks, total);
  const contentType = request.headers.get("content-type") ?? "";
  try {
    return await new Response(buffer as unknown as BodyInit, {
      headers: { "content-type": contentType },
    }).formData();
  } catch (error) {
    throw new MalformedMultipartError(error);
  }
};

/** The caller identity these routes need — deliberately narrower than a User. */
export type AuthenticatedCaller = { id: string };

export type ExistingResourceClaim = {
  source: string;
  created_by_user_id: string | null;
  hash: string | null;
};

export type UploadClaimVerdict =
  | { outcome: "replay" }
  | {
      outcome: "conflict";
      reason: "not_form_resource" | "different_owner" | "different_content";
    };

/**
 * Decide whether an upload naming an already-existing resource id is an
 * idempotent replay or a conflicting claim.
 *
 * First writer owns the id: only the original uploader re-sending
 * byte-identical content is honoured. Resource ids travel in synced form_data,
 * so anything else must leave the stored bytes and scope untouched.
 */
export const classifyExistingResourceClaim = (
  existing: ExistingResourceClaim,
  params: { callerId: string; digest: string; expectedSource: string },
): UploadClaimVerdict => {
  if (existing.source !== params.expectedSource) {
    return { outcome: "conflict", reason: "not_form_resource" };
  }
  if (existing.created_by_user_id !== params.callerId) {
    return { outcome: "conflict", reason: "different_owner" };
  }
  if (existing.hash === null || existing.hash !== params.digest) {
    return { outcome: "conflict", reason: "different_content" };
  }
  return { outcome: "replay" };
};

/** Read a single cookie's value from a raw Cookie header, or null if absent. */
const readCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== name) continue;
    const value = pair.slice(separator + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
};

const callerForToken = async (
  token: string,
): Promise<AuthenticatedCaller | null> => {
  const userOption = await Token.getUser(token);
  if (Option.isNone(userOption)) return null;
  const id = (userOption.value as { id?: string }).id;
  return id ? { id } : null;
};

/**
 * Resolve the caller from a Bearer session token, HTTP Basic "email:password",
 * or the portal's `token` session cookie, in that order — Basic is last
 * because it runs bcrypt. The cookie path lets a same-origin portal
 * `<img>`/`<a>` carry its session automatically, safe because the cookie is
 * httpOnly + SameSite=Lax.
 *
 * Returns null for any missing/invalid credential without distinguishing which.
 */
export const authenticateCaller = createServerOnlyFn(
  async (request: Request): Promise<AuthenticatedCaller | null> => {
    const authHeader = request.headers.get("Authorization");

    try {
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7).trim();
        if (!token) return null;
        return await callerForToken(token);
      }

      if (authHeader?.startsWith("Basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
        const separator = decoded.indexOf(":");
        if (separator === -1) return null;
        const email = decoded.slice(0, separator);
        const password = decoded.slice(separator + 1);
        if (!email || !password) return null;

        const user = await User.verifyCredentials(email, password);
        return { id: user.id };
      }

      const cookieToken = readCookie(request, "token");
      if (cookieToken) return await callerForToken(cookieToken);

      return null;
    } catch {
      return null;
    }
  },
);

export type GrantedCaller = AuthenticatedCaller & { grantId: string };

/**
 * Resolve a caller from an access-grant token in the query string.
 *
 * Deliberately NOT folded into `authenticateCaller`: a grant token travels
 * inside a file that leaves the building, so doing that would silently make it
 * a credential for uploads and deletes too. Routes opt in by calling this with
 * the scope they require.
 */
export const resolveGrantedCaller = createServerOnlyFn(
  async (
    request: Request,
    required: { scope: AccessGrant.Scope; subjectId?: string | null },
  ): Promise<GrantedCaller | null> => {
    const token = new URL(request.url).searchParams.get(
      ACCESS_GRANT_QUERY_PARAM,
    );
    if (!token) return null;

    const grant = await AccessGrant.resolve(token, required);
    if (!grant) return null;

    return { id: grant.userId, grantId: grant.id };
  },
);

/** Best-effort request context for audit logging from a web Request. */
export const buildRequestContext = (
  request: Request,
): EventLog.RequestContext => {
  const forwarded = request.headers.get("x-forwarded-for");
  const ipAddress = forwarded
    ? (forwarded.split(",")[0]?.trim() ?? null)
    : null;
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const deviceId = createHash("sha256").update(userAgent).digest("hex");
  return { ipAddress, deviceId, appId: "mobile" };
};

// The shared db is typed from the codegen'd schema, while logEvent declares its
// own event_logs shape. Kysely's generic is invariant, so the structurally
// equivalent types need a cast at the boundary.
type EventLogDatabase = Parameters<typeof EventLog.logEvent>[0];

/**
 * Write an audit entry for a resource access. Propagates on failure so read
 * paths can fail closed (no audit record → no PHI served).
 */
export const logResourceAudit = createServerOnlyFn(
  async (
    request: Request,
    params: {
      actionType: EventLog.ActionType;
      resourceId: string;
      userId: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> => {
    await EventLog.logEvent(
      db as unknown as EventLogDatabase,
      {
        actionType: params.actionType,
        tableName: "resources",
        rowId: params.resourceId,
        changes: { id: params.resourceId },
        userId: params.userId,
        metadata: params.metadata ?? null,
      },
      buildRequestContext(request),
    );
  },
);
