// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ default: {} }));
vi.mock("@tanstack/react-start/server", () => ({ setCookie: vi.fn() }));
vi.mock("@/lib/auth/sign-in-audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/sign-in-audit")>()),
  recordSignInFailure: vi.fn(),
  recordSignInRateLimited: vi.fn(),
  recordSignInSuccess: vi.fn(),
}));

import { commandAppRouter } from "@/integrations/trpc/router";
import { attemptSignIn } from "@/lib/auth/sign-in";
import User from "@/models/user";

/** The per-account limit in `sign-in.ts`: 10 attempts per 15 minutes. */
const ACCOUNT_ATTEMPTS_MAX = 10;
let ipCounter = 0;

const freshIp = () => `192.0.2.${++ipCounter}`;

const rpcLogin = (ip: string, email: string) =>
  commandAppRouter
    .createCaller({
      authHeader: null,
      client: { channel: "rpc", ipAddress: ip, userAgent: "vitest" },
    })
    .login({ email, password: "wrong" });

const restLogin = (ip: string, email: string) =>
  attemptSignIn(
    new Request("http://localhost/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: "wrong" }),
    }),
    "mobile",
  );

const signIn = vi.spyOn(User, "signIn");

beforeEach(() => {
  signIn.mockReset();
  signIn.mockRejectedValue(new Error("Invalid password"));
});

describe("tRPC login rate limit", () => {
  it("rejects with TOO_MANY_REQUESTS once the account budget is spent", async () => {
    const ip = freshIp();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPTS_MAX; attempt++) {
      await expect(rpcLogin(ip, "joy@example.org")).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    }

    await expect(rpcLogin(ip, "joy@example.org")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(signIn).toHaveBeenCalledTimes(ACCOUNT_ATTEMPTS_MAX);
  });

  it("gives another email from the same address its own budget", async () => {
    const ip = freshIp();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPTS_MAX; attempt++) {
      await rpcLogin(ip, "joy@example.org").catch(() => undefined);
    }

    await expect(rpcLogin(ip, "amina@example.org")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("shares one bucket with the REST login", async () => {
    const ip = freshIp();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPTS_MAX; attempt++) {
      expect((await restLogin(ip, "joy@example.org")).kind).toBe("invalid");
    }

    await expect(rpcLogin(ip, "joy@example.org")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect((await restLogin(ip, "joy@example.org")).kind).toBe("rate-limited");
  });
});
