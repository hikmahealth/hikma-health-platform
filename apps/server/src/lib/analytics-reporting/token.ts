import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

/** tolerated clock drift between this instance and the backoffice */
const CLOCK_SKEW_SECONDS = 60;

const encodeSegment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const decodeSegment = (segment: string): unknown => {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** SHA-256 hex of `body`; an empty body is hashed too, never sent as `""`. */
export function digestBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Signs a backoffice request token bound to `body` (`""` for GET and DELETE). */
export function signRequestToken(
  credentials: { client_id: string; client_signing_key: string },
  body: string,
  now_ms = Date.now(),
): string {
  const header = encodeSegment({ alg: "EdDSA", typ: "JWT" });
  const claims = encodeSegment({
    sub: credentials.client_id,
    iat: Math.floor(now_ms / 1000),
    digest: digestBody(body),
  });
  const key = createPrivateKey({
    key: Buffer.from(credentials.client_signing_key, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, Buffer.from(`${header}.${claims}`), key);
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

export type PullTokenResult = { ok: true } | { ok: false; reason: string };

/** Verifies a backoffice pull token: EdDSA signature, `sub`, freshness and body digest. */
export function verifyPullToken(
  token: string,
  body: string,
  credentials: { client_verifying_key: string; reporter_id: string },
  now_ms = Date.now(),
): PullTokenResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [headerSegment, claimsSegment, signatureSegment] = parts;

  const header = decodeSegment(headerSegment);
  if (!isRecord(header) || header.alg !== "EdDSA") {
    return { ok: false, reason: "unsupported algorithm" };
  }

  const key = createPublicKey({
    key: Buffer.from(credentials.client_verifying_key, "base64url"),
    format: "der",
    type: "spki",
  });
  const signed = verify(
    null,
    Buffer.from(`${headerSegment}.${claimsSegment}`),
    key,
    Buffer.from(signatureSegment, "base64url"),
  );
  if (!signed) return { ok: false, reason: "invalid signature" };

  const claims = decodeSegment(claimsSegment);
  if (!isRecord(claims)) return { ok: false, reason: "malformed claims" };
  if (claims.sub !== credentials.reporter_id) {
    return { ok: false, reason: "unexpected subject" };
  }

  const now_s = now_ms / 1000;
  if (typeof claims.exp !== "number") return { ok: false, reason: "missing exp" };
  if (now_s > claims.exp + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "token expired" };
  }
  if (typeof claims.iat !== "number") return { ok: false, reason: "missing iat" };
  if (claims.iat > now_s + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "token issued in the future" };
  }

  if (typeof claims.digest !== "string") {
    return { ok: false, reason: "missing digest" };
  }
  const expected = Buffer.from(digestBody(body));
  const received = Buffer.from(claims.digest.toLowerCase());
  if (expected.length !== received.length) {
    return { ok: false, reason: "body digest mismatch" };
  }
  if (!timingSafeEqual(expected, received)) {
    return { ok: false, reason: "body digest mismatch" };
  }

  return { ok: true };
}
