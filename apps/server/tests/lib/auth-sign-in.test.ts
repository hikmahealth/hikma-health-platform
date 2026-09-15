import { describe, it, expect, vi, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The module under test pulls in the DB-backed models and the TanStack request
// context; both are stubbed so this stays a unit test.
const signIn = vi.fn();
const getById = vi.fn();
const setCookie = vi.fn();

vi.mock("@/models/user", () => ({
  default: { signIn: (...a: unknown[]) => signIn(...a) },
}));
vi.mock("@/models/clinic", () => ({
  default: { getById: (...a: unknown[]) => getById(...a) },
}));
vi.mock("@tanstack/react-start/server", () => ({
  setCookie: (...a: unknown[]) => setCookie(...a),
}));
vi.mock("@hikmahealth/js-utils", () => ({
  Logger: { error: vi.fn(), info: vi.fn() },
}));

const { attemptSignIn } = await import("../../src/lib/auth/sign-in");

// The limiters are module singletons keyed on client IP (and email), so every
// test uses its own IP rather than trying to reset shared state between runs.
let ipCounter = 0;
const requestFrom = (body: unknown, ip = `10.0.0.${++ipCounter}`) =>
  new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

const credentials = {
  email: "clinician@example.com",
  password: "correct-horse",
};

describe("attemptSignIn", () => {
  beforeEach(() => {
    signIn.mockReset();
    getById.mockReset();
    setCookie.mockReset();
  });

  it("returns the user with the password masked and the clinic name attached", async () => {
    signIn.mockResolvedValue({
      user: {
        id: "u1",
        email: credentials.email,
        clinic_id: "c1",
        hashed_password: "$2b$real",
      },
      token: "tok-123",
    });
    getById.mockResolvedValue({ id: "c1", name: "Kilimanjaro Clinic" });

    const result = await attemptSignIn(requestFrom(credentials));

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.token).toBe("tok-123");
    expect(result.user.clinic_name).toBe("Kilimanjaro Clinic");
    expect(result.user.hashed_password).toBe("************");
    expect(result.user.hashed_password).not.toContain("$2b$");
  });

  it("skips the clinic lookup when the user has no clinic", async () => {
    signIn.mockResolvedValue({
      user: {
        id: "u2",
        email: credentials.email,
        clinic_id: null,
        hashed_password: "x",
      },
      token: "tok",
    });

    const result = await attemptSignIn(requestFrom(credentials));

    expect(result.kind).toBe("ok");
    expect(getById).not.toHaveBeenCalled();
    if (result.kind === "ok") expect(result.user.clinic_name).toBeUndefined();
  });

  it("sets the session cookie httpOnly, lax and path-scoped to the site root", async () => {
    signIn.mockResolvedValue({
      user: { id: "u3", clinic_id: null, hashed_password: "x" },
      token: "tok-cookie",
    });

    await attemptSignIn(requestFrom(credentials));

    expect(setCookie).toHaveBeenCalledTimes(1);
    const [name, value, opts] = setCookie.mock.calls[0];
    expect(name).toBe("token");
    expect(value).toBe("tok-cookie");
    expect(opts).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("reports invalid rather than leaking why the credentials failed", async () => {
    signIn.mockRejectedValue(new Error("User not found"));

    const result = await attemptSignIn(requestFrom(credentials));

    expect(result).toEqual({ kind: "invalid" });
    expect(JSON.stringify(result)).not.toContain("User not found");
    expect(setCookie).not.toHaveBeenCalled();
  });

  it("rate-limits one account behind an IP after 10 attempts and reports a retry delay", async () => {
    signIn.mockRejectedValue(new Error("Invalid password"));
    const ip = "10.9.9.9";

    for (let i = 0; i < 10; i++) {
      expect((await attemptSignIn(requestFrom(credentials, ip))).kind).toBe(
        "invalid",
      );
    }

    const blocked = await attemptSignIn(requestFrom(credentials, ip));
    expect(blocked.kind).toBe("rate-limited");
    if (blocked.kind === "rate-limited") {
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  it("checks the limit before touching credentials, so a blocked IP cannot probe", async () => {
    signIn.mockResolvedValue({
      user: { id: "u", clinic_id: null },
      token: "t",
    });
    const ip = "10.8.8.8";
    for (let i = 0; i < 10; i++)
      await attemptSignIn(requestFrom(credentials, ip));
    signIn.mockClear();

    const blocked = await attemptSignIn(requestFrom(credentials, ip));

    expect(blocked.kind).toBe("rate-limited");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("shares one bucket across callers, so /api/login cannot bypass the limit", async () => {
    // Both routes call this same function; exhausting the budget through one
    // entry point must block the other. This is what the old proxy hop gave us
    // implicitly and what a direct call must not lose.
    signIn.mockRejectedValue(new Error("Invalid password"));
    const ip = "10.7.7.7";

    for (let i = 0; i < 10; i++)
      await attemptSignIn(requestFrom(credentials, ip));

    const viaOtherRoute = await attemptSignIn(
      new Request("http://localhost/api/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(credentials),
      }),
    );
    expect(viaOtherRoute.kind).toBe("rate-limited");
  });

  // A whole site behind one router must not lock itself out.
  it("gives each account behind a shared IP its own budget", async () => {
    signIn.mockRejectedValue(new Error("Invalid password"));
    const ip = "10.6.6.6";

    for (let i = 0; i < 10; i++)
      await attemptSignIn(requestFrom(credentials, ip));

    expect((await attemptSignIn(requestFrom(credentials, ip))).kind).toBe(
      "rate-limited",
    );
    const colleague = await attemptSignIn(
      requestFrom({ ...credentials, email: "colleague@example.com" }, ip),
    );
    expect(colleague.kind).toBe("invalid");
  });

  it("lets a 30-person site all log in from one IP", async () => {
    signIn.mockResolvedValue({ user: { id: "u", clinic_id: null }, token: "t" });
    const ip = "10.5.5.5";

    for (let i = 0; i < 30; i++) {
      const result = await attemptSignIn(
        requestFrom({ ...credentials, email: `staff${i}@example.com` }, ip),
      );
      expect(result.kind).toBe("ok");
    }
  });

  // The email is unverified, so rotating it must not be a bypass.
  it("caps an IP rotating emails at 300 attempts, without checking credentials", async () => {
    signIn.mockRejectedValue(new Error("Invalid password"));
    const ip = "10.4.4.4";

    for (let i = 0; i < 300; i++) {
      const result = await attemptSignIn(
        requestFrom({ ...credentials, email: `guess${i}@example.com` }, ip),
      );
      expect(result.kind).toBe("invalid");
    }
    signIn.mockClear();

    const blocked = await attemptSignIn(
      requestFrom({ ...credentials, email: "fresh@example.com" }, ip),
    );
    expect(blocked.kind).toBe("rate-limited");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("puts attempts with no usable email in one shared bucket", async () => {
    signIn.mockRejectedValue(new Error("Invalid password"));
    const ip = "10.3.3.3";

    for (let i = 0; i < 10; i++)
      await attemptSignIn(requestFrom({ password: "x" }, ip));

    const blocked = await attemptSignIn(requestFrom({ email: 42 }, ip));
    expect(blocked.kind).toBe("rate-limited");
  });
});

/**
 * The bug this module was extracted to fix lived in a route handler, not in
 * any function above: `/api/login` reached `/api/auth/sign-in` over the
 * network with `fetch(new Request(url, request))`. A Request built from
 * another Request has no rewindable body source, so any 3xx on that self-fetch
 * made undici return a bare network error — `TypeError: fetch failed`, an
 * unhandled 500, and no way to log in.
 *
 * The tests above would all still pass if someone reintroduced that hop, so
 * this pins the invariant the fix actually established.
 */
describe("api route handlers", () => {
  const apiDir = join(__dirname, "../../src/routes/api");

  it("never re-issue an inbound Request as an outbound one", () => {
    const offenders = readdirSync(apiDir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
      .filter((f) =>
        /new Request\s*\(/.test(readFileSync(join(apiDir, f), "utf8")),
      );

    expect(offenders).toEqual([]);
  });
});
