import { describe, it, expect } from "vitest";
import { claimedAccountKey, createRateLimiter } from "@/lib/rate-limiter";

// `createRateLimiter` is already key-agnostic — every existing call site just
// happens to pass an IP. These pin the property the backfill limiter depends
// on, so a future change that assumes an IP key breaks here rather than in
// production, where the symptom would be one clinic's devices sharing a quota.
describe("rate limiter keyed on identity", () => {
  it("counts two identities behind one IP separately", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2 });
    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(true);
    expect(limiter.check("user-a").allowed).toBe(false);
    expect(limiter.check("user-b").allowed).toBe(true);
  });

  it("supplies a retry hint once exhausted", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check("k");
    const blocked = limiter.check("k");
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error("expected the request to be blocked");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("stops at the configured ceiling rather than near it", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 600 });
    for (let i = 0; i < 600; i++) {
      expect(limiter.check("caller").allowed).toBe(true);
    }
    expect(limiter.check("caller").allowed).toBe(false);
  });
});

describe("claimedAccountKey", () => {
  const withAuth = (authorization?: string) =>
    new Request("http://localhost/", {
      headers: authorization ? { Authorization: authorization } : {},
    });
  const basic = (credentials: string) =>
    withAuth(`Basic ${Buffer.from(credentials).toString("base64")}`);

  it("keys a Basic request on its email, not its password", () => {
    expect(claimedAccountKey(basic("a@x.org:one"))).toBe(
      claimedAccountKey(basic("a@x.org:two")),
    );
  });

  it("gives different emails different keys", () => {
    expect(claimedAccountKey(basic("a@x.org:pw"))).not.toBe(
      claimedAccountKey(basic("b@x.org:pw")),
    );
  });

  it("never holds the email itself", () => {
    expect(claimedAccountKey(basic("a@x.org:pw"))).not.toContain("a@x.org");
  });

  it("keys a Bearer request on a hash of its token", () => {
    const key = claimedAccountKey(withAuth("Bearer secret-token"));
    expect(key).toMatch(/^t:[0-9a-f]{32}$/);
    expect(key).not.toContain("secret-token");
  });

  it.each([undefined, "", "Bearer ", "Basic ", "Digest abc"])(
    "names no account for %j",
    (authorization) => {
      expect(claimedAccountKey(withAuth(authorization))).toBeNull();
    },
  );
});
