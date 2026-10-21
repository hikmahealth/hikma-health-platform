import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Asserts every `createServerFn` is authorized or explicitly public.
 *
 * Each one compiles to an independently-addressable HTTP endpoint. The
 * `beforeLoad` redirect on /app only affects navigation and does not protect
 * them, so an endpoint with no gate silently works for anonymous callers.
 */

const SERVER_SRC = join(__dirname, "../../src");

/**
 * Middleware that throws on an unauthorized caller, and so gates an endpoint on
 * its own. `permissionsMiddleware` is excluded: it calls `next()` with
 * `userId: null` when there is no token, so it proves nothing by itself.
 */
const ENFORCING_MIDDLEWARE = ["superAdminMiddleware", "adminMiddleware"];

/** Authorization checks available inside a handler body. */
const IN_BODY_AUTH_MARKERS = [
  "userRoleTokenHasCapability",
  "isAuthorizedWithClinic",
  "requireClinicPermission",
  "isUserSuperAdmin",
  "context.userId",
  "context.role",
  "context.permissions",
  "getCurrentUser",
];

/**
 * A check must deny, not just read the context. `return []` / `return null` are
 * accepted because loader-called endpoints fail closed that way rather than
 * throwing, which makes this a backstop against forgotten authorization rather
 * than proof of correct authorization.
 */
const REJECTION_MARKERS = [
  "Unauthorized",
  "FORBIDDEN",
  "throw ",
  "Promise.reject",
  "return []",
  "return null",
];

/** Endpoints meant to serve anonymous callers. The value is the justification. */
const PUBLIC_ALLOWLIST: Record<string, string> = {
  "routes/education/index.tsx::getPublicContent":
    "Public education library, non-PHI, handler filters to published+public",
  "routes/education/$id.tsx::getPublicContentById":
    "Public education article, non-PHI, handler filters to published+public",
  "routes/index.tsx::checkToken":
    "Pre-login probe deciding whether to redirect to /app; returns a boolean only",
  "lib/server-functions/setup.ts::getSetupStatusFn":
    "Pre-setup probe deciding whether /setup exists; returns a boolean only",
  "lib/server-functions/setup.ts::checkSetupTokenFn":
    "First-run setup, before any user exists; the setup token is the credential, rate limited per IP",
  "lib/server-functions/setup.ts::completeSetupFn":
    "First-run setup, before any user exists; the setup token is the credential, rate limited per IP, closed once setup completes",

  // Self-scoped: these read the caller's own cookie and cannot be pointed at
  // another user, so there is no subject to authorize against.
  "lib/server-functions/auth.ts::getCurrentUserId": "Caller's own id",
  "lib/server-functions/auth.ts::getCurrentUser": "Caller's own record",
  "lib/server-functions/auth.ts::currentUserHasPermissions":
    "Caller's own permission booleans",
  "lib/server-functions/users.ts::currentUserHasRole":
    "Caller's own role match",
  "lib/auth/request.ts::isUserSuperAdmin": "Caller's own role match",
  "lib/auth/request.ts::getCurrentUserId": "Caller's own id",
};

/** Gated in a helper the body scan cannot see. Each verified by reading it. */
const GATED_VIA_HELPER: Record<string, string> = {
  "lib/server-functions/users.ts::getAllUsers":
    "getAllUsersImpl gates on READ_USER and returns [] when unauthorized",
};

type ServerFn = {
  file: string;
  name: string;
  key: string;
  body: string;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(full) && !full.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extracts each `createServerFn` definition with its source text, which runs
 * from its declaration to the next one. Over-capturing is the safe direction:
 * it can only mask a missing gate, never invent one.
 */
function extractServerFns(file: string): ServerFn[] {
  const src = readFileSync(file, "utf8");
  const rel = relative(SERVER_SRC, file);
  const results: ServerFn[] = [];

  const declRe = /(?:export\s+)?const\s+(\w+)\s*=\s*createServerFn\b/g;
  const matches = [...src.matchAll(declRe)];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index!;
    // Skip commented-out declarations.
    const lineStart = src.lastIndexOf("\n", start) + 1;
    const linePrefix = src.slice(lineStart, start);
    if (linePrefix.trimStart().startsWith("//")) continue;

    const end = i + 1 < matches.length ? matches[i + 1].index! : src.length;
    results.push({
      file: rel,
      name: m[1],
      key: `${rel.replace(/\\/g, "/")}::${m[1]}`,
      body: src.slice(start, end),
    });
  }

  return results;
}

function isGated(fn: ServerFn): boolean {
  const { body } = fn;

  const middlewareBlock = body.match(/\.middleware\(\[([^\]]*)\]\)/)?.[1] ?? "";
  if (ENFORCING_MIDDLEWARE.some((mw) => middlewareBlock.includes(mw))) {
    return true;
  }

  const hasAuthMarker = IN_BODY_AUTH_MARKERS.some((mk) => body.includes(mk));
  const hasRejection = REJECTION_MARKERS.some((mk) => body.includes(mk));
  return hasAuthMarker && hasRejection;
}

const allServerFns = walk(SERVER_SRC).flatMap(extractServerFns);

describe("createServerFn authorization coverage", () => {
  // Without this, a regressed extractor makes every other assertion vacuous.
  it("finds server functions to check", () => {
    expect(allServerFns.length).toBeGreaterThan(30);
  });

  it("every server function is gated or explicitly allowlisted as public", () => {
    const ungated = allServerFns
      .filter((fn) => !isGated(fn))
      .filter((fn) => !(fn.key in PUBLIC_ALLOWLIST))
      .filter((fn) => !(fn.key in GATED_VIA_HELPER))
      .map((fn) => fn.key)
      .sort();

    expect(
      ungated,
      `These createServerFn endpoints have no authorization gate and are not on the\n` +
        `public allowlist. They are reachable over HTTP by anonymous callers.\n\n` +
        `Fix by attaching superAdminMiddleware/adminMiddleware, or by checking\n` +
        `context in the handler and rejecting. Only add to PUBLIC_ALLOWLIST if the\n` +
        `endpoint is genuinely meant to serve unauthenticated users.\n\n` +
        ungated.map((k) => `  - ${k}`).join("\n") +
        "\n",
    ).toEqual([]);
  });

  it("the allowlists have no stale entries", () => {
    const known = new Set(allServerFns.map((fn) => fn.key));
    const stale = [
      ...Object.keys(PUBLIC_ALLOWLIST),
      ...Object.keys(GATED_VIA_HELPER),
    ].filter((k) => !known.has(k));

    expect(
      stale,
      `PUBLIC_ALLOWLIST names endpoints that no longer exist. Remove them so the\n` +
        `allowlist cannot silently grant an exemption to a future endpoint that\n` +
        `reuses the name:\n` +
        stale.map((k) => `  - ${k}`).join("\n"),
    ).toEqual([]);
  });
});
