import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { HersError } from "./errors.js";
import type { HersWebhookEvent, WebhookEvent } from "./types.js";

/** Default allowed clock skew between `webhook-timestamp` and now, in seconds. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const SECRET_PREFIX = "whsec_";

export class WebhookVerificationError extends HersError {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** Node's `req.headers` (`IncomingHttpHeaders`) or a Fetch `Headers` object. */
export type WebhookHeaders = IncomingHttpHeaders | Headers;

export interface VerifyWebhookOptions {
  /** The `whsec_...` secret returned when the webhook was registered. */
  secret: string;
  headers: WebhookHeaders;
  /** The raw, unparsed request body. Do not re-serialize parsed JSON. */
  body: string | Buffer;
  /** Maximum allowed clock skew in seconds. Defaults to 300. */
  toleranceSeconds?: number;
  /** Override the current time (unix seconds). */
  now?: number;
}

export interface VerifiedWebhook<TEvent = HersWebhookEvent> {
  /** `webhook-id` header (`msg_...`). Stable across retries; use for deduplication. */
  id: string;
  /** `webhook-timestamp` header as unix seconds. */
  timestamp: number;
  event: TEvent;
}

function readHeader(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const value = (headers as IncomingHttpHeaders)[name];
  return Array.isArray(value) ? value[0] : value;
}

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  const key = Buffer.from(raw, "base64");
  if (key.length === 0) {
    throw new WebhookVerificationError(
      "webhook secret is empty or not valid base64",
    );
  }
  return key;
}

/**
 * Computes the Standard Webhooks `v1` signature (base64, without the `v1,` prefix)
 * for a payload.
 */
export function signWebhookPayload(
  secret: string,
  id: string,
  timestamp: number,
  body: string | Buffer,
): string {
  return createHmac("sha256", secretKey(secret))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest("base64");
}

/**
 * Verifies a HERS webhook delivery (Standard Webhooks spec) and returns the parsed event.
 *
 * Throws {@link WebhookVerificationError} if headers are missing, the timestamp is
 * outside the tolerance window, or no signature matches.
 *
 * ```ts
 * // Express: app.post("/hers/webhook", express.raw({ type: "application/json" }), handler)
 * const { id, event } = verifyWebhook({
 *   secret: process.env.HERS_WEBHOOK_SECRET!,
 *   headers: req.headers,
 *   body: req.body, // raw Buffer
 * });
 * if (event.type === "environment.anomaly_detected") { ... }
 * ```
 */
export function verifyWebhook<TEvent extends WebhookEvent = HersWebhookEvent>(
  options: VerifyWebhookOptions,
): VerifiedWebhook<TEvent> {
  const id = readHeader(options.headers, "webhook-id");
  const timestampHeader = readHeader(options.headers, "webhook-timestamp");
  const signatureHeader = readHeader(options.headers, "webhook-signature");

  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookVerificationError("missing required webhook headers");
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    throw new WebhookVerificationError("invalid webhook-timestamp header");
  }

  const now = Math.floor(options.now ?? Date.now() / 1000);
  const tolerance =
    options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      "webhook timestamp is outside the tolerance window",
    );
  }

  const expected = Buffer.from(
    signWebhookPayload(options.secret, id, timestamp, options.body),
    "utf8",
  );

  const matched = signatureHeader
    .split(" ")
    .filter(Boolean)
    .some((entry) => {
      const [version, sig] = entry.split(",", 2);
      if (version !== "v1" || sig === undefined) return false;
      const candidate = Buffer.from(sig, "utf8");
      return (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      );
    });

  if (!matched) {
    throw new WebhookVerificationError("no matching webhook signature");
  }

  let event: TEvent;
  try {
    event = JSON.parse(options.body.toString()) as TEvent;
  } catch {
    throw new WebhookVerificationError("webhook body is not valid JSON");
  }

  return { id, timestamp, event };
}
