import { createHash } from "node:crypto";
import { Logger } from "@hikmahealth/js-utils";

type RateLimiterConfig = {
  windowMs: number;
  maxRequests: number;
};

type RateLimiterEntry = { timestamps: number[] };

export type RateLimitResult =
  { allowed: true } | { allowed: false; retryAfterMs: number };

const toBoolean = function (s: string) {
  switch (s) {
    case "true":
    case "1":
      return true;
  }

  return false;
};

/**
 * Creates an in-memory sliding-window rate limiter.
 * Tracks request timestamps per key (typically IP) and rejects
 * requests that exceed the configured threshold.
 */
export const createRateLimiter = (config: RateLimiterConfig) => {
  const store = new Map<string, RateLimiterEntry>();

  // Clean up expired entries every 60s to prevent memory leaks
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter(
        (ts) => now - ts < config.windowMs,
      );
      if (entry.timestamps.length === 0) store.delete(key);
    }
  }, 60_000);
  cleanup.unref?.(); // Don't prevent process from exiting

  return {
    check(key: string): RateLimitResult {
      const disableRateLimit = toBoolean(
        process.env.HH_DISABLE_RATE_LIMITING ?? "false",
      );

      if (disableRateLimit) {
        return { allowed: true };
      }

      const now = Date.now();
      const entry = store.get(key) ?? { timestamps: [] };
      entry.timestamps = entry.timestamps.filter(
        (ts) => now - ts < config.windowMs,
      );

      if (entry.timestamps.length >= config.maxRequests) {
        const retryAfterMs = config.windowMs - (now - entry.timestamps[0]);
        return { allowed: false, retryAfterMs };
      }

      entry.timestamps.push(now);
      store.set(key, entry);
      return { allowed: true };
    },
  };
};

/** Extract client IP from request headers. */
export const getClientIp = (request: Request): string => {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
};

const hashKey = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 32);

/** Rate-limit key for an email, hashed so it never sits in a limiter's map. */
export const emailAccountKey = (email: string): string => `u:${hashKey(email)}`;

/**
 * Hashed rate-limit key for the account in the Authorization header, or null
 * when there is none. Unverified, so pair it with a per-IP backstop.
 */
export const claimedAccountKey = (request: Request): string | null => {
  const authorization = request.headers.get("Authorization") ?? "";
  const [scheme, credential = ""] = authorization.split(" ");

  if (scheme === "Basic") {
    const email = Buffer.from(credential, "base64").toString().split(":")[0];
    return email ? emailAccountKey(email) : null;
  }
  if (scheme === "Bearer" && credential.trim().length > 0) {
    return `t:${hashKey(credential.trim())}`;
  }
  return null;
};

/** Build a 429 Too Many Requests response. */
export const tooManyRequestsResponse = (retryAfterMs: number): Response =>
  new Response(
    JSON.stringify({ error: "Too many requests. Please try again later." }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil(retryAfterMs / 1000)),
      },
    },
  );
