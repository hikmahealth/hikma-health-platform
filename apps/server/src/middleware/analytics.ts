import { createMiddleware } from "@tanstack/react-start";
import { createHash, createPublicKey, timingSafeEqual, verify } from "crypto";
import { readCredentials } from "@/lib/analytics-reporting/credentials";
import jwt from "jsonwebtoken";
const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Middleware to authenticate the access in using the reporting service
 */
export const authAnalyticsMiddleware = createMiddleware().server(
  async function ({ request, next }) {
    const header = request.headers.get("Authorization");
    if (!header || !header.startsWith("Bearer ")) return unauthorized();

    try {
      // clone so the handler can still read the body
      const body = await request.clone().text();
      console.log("BODY:", body);
      await verifyAuthToken(header.substring(7), body);
    } catch (error) {
      console.warn(
        "analytics auth failed:",
        error instanceof Error ? error.message : error,
      );
      return unauthorized();
    }

    return next();
  },
);

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b);
}

async function verifyAuthToken(authToken: string, body: string) {
  const credentials = await readCredentials();
  if (!credentials) throw new Error("no reporting credentials registered");

  const parts = authToken.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;

  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  // // const signature = Buffer.from(s, "base64url");
  // // const signingInput = Buffer.from(`${h}.${p}`);
  const key = Buffer.from(credentials.client_verifying_key, "base64url");

  if (header.alg !== "RS256") {
    throw new Error("unsupported algorithm");
  }

  jwt.verify(authToken, createPublicKey(key), {
    complete: false,
    algorithms: ["RS256"],
  });

  if (typeof payload.digest !== "string") throw new Error("missing digest");
  const bodyDigest = createHash("md5").update(body).digest();
  if (!safeEqual(bodyDigest, Buffer.from(payload.digest.toLowerCase(), "hex")))
    throw new Error("body digest mismatch");
}
