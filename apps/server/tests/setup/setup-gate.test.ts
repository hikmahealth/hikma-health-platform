import { beforeEach, describe, expect, it, vi } from "vitest";

const { isSetupComplete, attemptSignIn, fetchRequestHandler } = vi.hoisted(
  () => ({
    isSetupComplete: vi.fn<() => Promise<boolean>>(),
    attemptSignIn: vi.fn(),
    fetchRequestHandler: vi.fn(),
  }),
);

vi.mock("@/lib/setup/is-setup-complete", () => ({ isSetupComplete }));
vi.mock("@/lib/auth/sign-in", () => ({ attemptSignIn }));
vi.mock("@trpc/server/adapters/fetch", () => ({ fetchRequestHandler }));
vi.mock("@/integrations/trpc/router", () => ({
  commandAppRouter: {},
  queryAppRouter: {},
}));
vi.mock("@/integrations/trpc/init", () => ({ createTRPCContext: vi.fn() }));

import { Route as LoginRoute } from "@/routes/api/login";
import { Route as SignInRoute } from "@/routes/api/auth.sign-in";
import { Route as CommandRoute } from "@/routes/rpc.command.$";
import { Route as QueryRoute } from "@/routes/rpc.query.$";

type Handler = (context: { request: Request }) => Promise<Response>;
const handlersOf = (route: unknown): Record<string, Handler> =>
  (route as { options: { server: { handlers: Record<string, Handler> } } })
    .options.server.handlers;

let ipCounter = 0;
const request = (path: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${++ipCounter}`,
    },
    body: "{}",
  });

const gated: [string, Handler][] = [
  ["/api/login", handlersOf(LoginRoute).POST],
  ["/api/auth/sign-in", handlersOf(SignInRoute).POST],
  ["/rpc/command/patients.list", handlersOf(CommandRoute).POST],
  ["/rpc/query/patients.list", handlersOf(QueryRoute).POST],
];

beforeEach(() => {
  vi.clearAllMocks();
  attemptSignIn.mockResolvedValue({ kind: "invalid" });
  fetchRequestHandler.mockResolvedValue(new Response("ok"));
});

describe.each(gated)("%s", (path, handler) => {
  it("answers 503 setup_required while setup is pending, without handling the request", async () => {
    isSetupComplete.mockResolvedValue(false);

    const response = await handler({ request: request(path) });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "setup_required" });
    expect(attemptSignIn).not.toHaveBeenCalled();
    expect(fetchRequestHandler).not.toHaveBeenCalled();
  });

  it("handles the request as before once setup is complete", async () => {
    isSetupComplete.mockResolvedValue(true);

    const response = await handler({ request: request(path) });

    expect(response.status).not.toBe(503);
    expect(
      attemptSignIn.mock.calls.length + fetchRequestHandler.mock.calls.length,
    ).toBe(1);
  });
});
