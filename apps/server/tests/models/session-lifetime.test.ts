/**
 * One session lifetime, enforced across every login path.
 *
 * `User.signIn` defaults `validHours` to 2; the tRPC `login` procedure used to
 * pass 24, so a session lasted twelve times longer depending on which endpoint
 * the device signed in through — which made expired-token bugs look intermittent.
 *
 * These read source rather than the database, so they run without one. The hub
 * pins the same number in `crypto/jwt.rs` (`default_ttl_is_two_hours`).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = join(__dirname, "..", "..", "src");
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), "utf8");

/** Login paths that mint a provider token. */
const LOGIN_CALL_SITES = [
  "integrations/trpc/routers/commands.ts",
  "lib/auth/sign-in.ts",
  "lib/form-resources.ts",
  "routes/api/v2.sync.tsx",
];

describe("session lifetime", () => {
  it("User.signIn defaults to 2 hours", () => {
    expect(read("models", "user.ts")).toContain("validHours: number = 2");
  });

  // A third argument to `User.signIn` overrides the default. If a path ever
  // genuinely needs its own lifetime, change this test deliberately and say why.
  it.each(LOGIN_CALL_SITES)("%s does not override the default lifetime", (file) => {
    const source = read(...file.split("/"));
    const calls = [...source.matchAll(/User\.signIn\(([^)]*)\)/gs)];

    for (const [, args] of calls) {
      const arity = args.trim() === "" ? 0 : args.split(",").filter((a) => a.trim()).length;
      expect(arity).toBeLessThanOrEqual(2);
    }
  });

  // Guards the guard: if `User.signIn` is renamed, the rule above matches
  // nothing and passes while enforcing nothing.
  it("finds the login call sites it claims to check", () => {
    const found = LOGIN_CALL_SITES.filter((file) =>
      read(...file.split("/")).includes("User.signIn("),
    );
    expect(found).toEqual(LOGIN_CALL_SITES);
  });
});
