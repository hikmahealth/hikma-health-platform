import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { HersError } from "./errors.js";

/** Maximum token lifetime the server accepts, in seconds. */
export const MAX_TOKEN_TTL_SECONDS = 300;

export interface ClientCredentials {
  clientId: string;
  /** Base64-encoded PKCS#8 DER Ed25519 private key (or a PEM-wrapped version of it). */
  signingKey: string;
}

export interface SignTokenOptions {
  /** Token lifetime in seconds. Capped at 300. Defaults to 300. */
  ttlSeconds?: number;
  /** Override the current time (unix seconds). */
  now?: number;
}

const base64Url = (input: string | Buffer) =>
  (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString(
    "base64url",
  );

/** Parses a base64 PKCS#8 DER (or PEM) Ed25519 private key into a Node `KeyObject`. */
export function importSigningKey(signingKey: string): KeyObject {
  let key: KeyObject;
  try {
    key = signingKey.includes("-----BEGIN")
      ? createPrivateKey(signingKey)
      : createPrivateKey({
          key: Buffer.from(signingKey.replace(/\s+/g, ""), "base64"),
          format: "der",
          type: "pkcs8",
        });
  } catch (cause) {
    throw new HersError(
      "failed to import signing key (expected a base64 PKCS#8 DER Ed25519 private key)",
      { cause },
    );
  }

  if (key.asymmetricKeyType !== "ed25519") {
    throw new HersError(
      `signing key must be Ed25519, got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }
  return key;
}

/**
 * Signs a short-lived EdDSA JWT for the given client.
 *
 * `key` may be the base64 signing key or an already-imported `KeyObject`.
 */
export function signToken(
  clientId: string,
  key: string | KeyObject,
  options: SignTokenOptions = {},
): string {
  const keyObject = typeof key === "string" ? importSigningKey(key) : key;
  const ttl = Math.min(
    options.ttlSeconds ?? MAX_TOKEN_TTL_SECONDS,
    MAX_TOKEN_TTL_SECONDS,
  );
  if (!(ttl > 0)) {
    throw new HersError("ttlSeconds must be a positive number");
  }

  const iat = Math.floor(options.now ?? Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iss: clientId, iat, exp: iat + Math.floor(ttl) }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign(null, Buffer.from(signingInput, "utf8"), keyObject);

  return `${signingInput}.${base64Url(signature)}`;
}

/** Returns a bearer token. Called before every authenticated request. */
export type TokenProvider = () => string | Promise<string>;

export interface CachedTokenProviderOptions {
  /** Token lifetime in seconds. Capped at 300. Defaults to 300. */
  ttlSeconds?: number;
  /** Refresh the token this many seconds before it expires. Defaults to 30. */
  refreshLeewaySeconds?: number;
  /** Clock source in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Creates a token provider that signs tokens with the client's credentials and
 * caches them until shortly before they expire.
 *
 * The signing key is parsed eagerly, so an invalid key throws here.
 */
export function createTokenProvider(
  credentials: ClientCredentials,
  options: CachedTokenProviderOptions = {},
): TokenProvider {
  const ttl = Math.min(
    options.ttlSeconds ?? MAX_TOKEN_TTL_SECONDS,
    MAX_TOKEN_TTL_SECONDS,
  );
  const leeway = Math.max(
    0,
    Math.min(options.refreshLeewaySeconds ?? 30, ttl - 1),
  );
  const now = options.now ?? Date.now;
  const key = importSigningKey(credentials.signingKey);

  let cached: { token: string; refreshAt: number } | undefined;

  return () => {
    const iat = Math.floor(now() / 1000);
    if (cached && iat < cached.refreshAt) {
      return cached.token;
    }

    const token = signToken(credentials.clientId, key, {
      ttlSeconds: ttl,
      now: iat,
    });
    cached = { token, refreshAt: iat + ttl - leeway };
    return token;
  };
}
