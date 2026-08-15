import { createHash } from "node:crypto";
import type { ConfigField, PutOutput, StoreType } from "../types.ts";
import { UPLOAD_SIZE_LIMIT_BYTES, isAllowedMimetype } from "../types.ts";

/**
 * `name` is written to `resources.store`, which is how a file uploaded under
 * one backend is still read back after the active backend changes.
 */
export type StorageAdapter = {
  readonly name: StoreType;
  readonly version: string;
  put(
    data: Uint8Array,
    destination: string,
    mimetype?: string,
  ): Promise<PutOutput>;
  delete(uri: string): Promise<void>;
  downloadAsBytes(uri: string): Promise<Uint8Array>;
  /**
   * Idempotently create the bucket, container or base directory. Never call
   * this from a request path: it costs a round trip and needs create
   * permissions a least-privilege credential will not have.
   */
  ensureContainer(): Promise<void>;
};

/** Resolved configuration for one adapter, keyed by `ConfigField.key`. */
export type StorageConfig = Readonly<Record<string, string | undefined>>;

/**
 * Validate size and mimetype before writing to any adapter.
 * Call at the top of every adapter's `put` implementation.
 */
export const validatePut = (data: Uint8Array, mimetype?: string): void => {
  if (data.byteLength > UPLOAD_SIZE_LIMIT_BYTES) {
    throw new Error(
      `Upload exceeds size limit: ${data.byteLength} bytes > ${UPLOAD_SIZE_LIMIT_BYTES} bytes`,
    );
  }
  if (mimetype !== undefined && !isAllowedMimetype(mimetype)) {
    throw new Error(`Mimetype not allowed: ${mimetype}`);
  }
};

/**
 * Merge stored values with unsaved overrides and per-field defaults. A blank
 * override means "leave this field alone", which is how an untouched secret
 * input round-trips. Throws if a required field resolves to nothing.
 */
export const resolveConfig = (
  fields: readonly ConfigField[],
  stored: Readonly<Record<string, string | null>>,
  overrides: Readonly<Record<string, string>> = {},
): StorageConfig => {
  const config: Record<string, string> = {};

  for (const field of fields) {
    const override = overrides[field.key];
    const storedValue = stored[field.key];
    const value =
      override !== undefined && override !== ""
        ? override
        : storedValue !== null && storedValue !== undefined && storedValue !== ""
          ? storedValue
          : field.default;

    if (value === undefined) {
      if (field.required) {
        throw new Error(`${field.label} is required (${field.key})`);
      }
      continue;
    }
    config[field.key] = value;
  }

  return config;
};

/**
 * Best-effort HTTP status from a cloud SDK error. AWS nests it under
 * `$metadata`, Azure uses `statusCode`, Google uses `code`. Undefined means
 * "no status found" — never treat that as success.
 */
export const httpStatusOf = (error: unknown): number | undefined => {
  if (error == null || typeof error !== "object") return undefined;
  const candidate = error as {
    $metadata?: { httpStatusCode?: number };
    statusCode?: unknown;
    code?: unknown;
  };
  if (typeof candidate.$metadata?.httpStatusCode === "number") {
    return candidate.$metadata.httpStatusCode;
  }
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
};

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.local$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  // 169.254.169.254 is the cloud instance-metadata address
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?::\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

/**
 * Rewrite an IPv4-mapped IPv6 literal to its dotted quad.
 *
 * The URL parser canonicalises decimal, hex and octal IPv4 into a dotted quad
 * before we ever see it, but it leaves IPv6 alone — so `[::ffff:127.0.0.1]`
 * and its hex twin `[::ffff:7f00:1]` reach the patterns still wearing the
 * costume. Returns the host unchanged when it is not a mapped address.
 */
const unwrapMappedIpv4 = (host: string): string => {
  const inner = host.replace(/^\[/, "").replace(/\]$/, "");

  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(inner);
  if (dotted?.[1]) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }

  return host;
};

/**
 * Reject an admin-supplied S3 endpoint pointing somewhere it should not.
 * Obvious cases only: a hostname resolving to a private address at request
 * time still passes, since pinning is not exposed by the SDK.
 */
export const assertSafeEndpoint = (
  raw: string,
  allowInsecure: boolean,
): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Endpoint URL is not a valid URL: ${raw}`);
  }

  const isHttps = url.protocol === "https:";
  const isPermittedHttp = allowInsecure && url.protocol === "http:";
  if (!isHttps && !isPermittedHttp) {
    throw new Error("Endpoint URL must use https");
  }

  const host = url.hostname;
  const candidates = [host, unwrapMappedIpv4(host)];
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (candidates.some((candidate) => pattern.test(candidate))) {
      throw new Error(
        `Endpoint URL must not point at a private or loopback address: ${host}`,
      );
    }
  }
};

/**
 * Stable fingerprint of a field set's stored values. Adapters are cached
 * against it, so a config change on one instance is picked up by every other
 * instance without any cache-busting message between them.
 */
export const configFingerprint = (
  fields: readonly ConfigField[],
  values: Readonly<Record<string, string | null>>,
): string => {
  const pairs = fields
    .map((field): readonly [string, string] => [
      field.key,
      values[field.key] ?? "",
    ])
    .sort((left, right) => (left[0] < right[0] ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
};
