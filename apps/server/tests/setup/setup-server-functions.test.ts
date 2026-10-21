import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeSetup, checkSetupToken } = vi.hoisted(() => ({
  completeSetup: vi.fn(),
  checkSetupToken: vi.fn(),
}));

// Each exported server function becomes its bare handler.
vi.mock("@tanstack/react-start", () => {
  const builder = {
    validator: () => builder,
    middleware: () => builder,
    handler: (fn: unknown) => fn,
  };
  return {
    createServerFn: () => builder,
    createServerOnlyFn: (fn: unknown) => fn,
  };
});
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("http://localhost/", {
      headers: { "x-forwarded-for": "198.51.100.77" },
    }),
}));
vi.mock("@/db", () => ({ default: {} }));
vi.mock("@/lib/server-functions/audit", () => ({ logAuditEvent: vi.fn() }));
vi.mock("@/lib/setup/is-setup-complete", () => ({
  isSetupComplete: vi.fn(async () => false),
}));
vi.mock("@/middleware/auth", () => ({ adminMiddleware: {} }));
vi.mock("@/lib/setup/complete-setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/setup/complete-setup")>()),
  completeSetup,
  checkSetupToken,
}));

import {
  checkSetupTokenFn,
  completeSetupFn,
} from "@/lib/server-functions/setup";
import type { SetupInput } from "@/lib/setup/complete-setup";

type Handler<T> = (args: { data: T }) => Promise<{ kind: string }>;
const complete = completeSetupFn as unknown as Handler<SetupInput>;
const check = checkSetupTokenFn as unknown as Handler<{ token: string }>;

const input = (overrides: Partial<SetupInput> = {}): SetupInput => ({
  token: "TOKEN",
  organizationName: "Org",
  clinicName: "Clinic",
  clinicCountry: "",
  clinicCity: "",
  adminName: "Amina",
  adminEmail: "amina@example.org",
  adminPassword: "clinic-north-wing-2026",
  acknowledgedDataResponsibility: true,
  ...overrides,
});

beforeEach(() => {
  completeSetup.mockResolvedValue({ kind: "invalid-token" });
  checkSetupToken.mockResolvedValue({ kind: "invalid-token" });
});

describe("setup server functions", () => {
  it("does not spend rate-limit attempts on rejected input", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const outcome = await complete({
        data: input({ adminPassword: "password1" }),
      });
      expect(outcome).toMatchObject({
        kind: "invalid-input",
        field: "adminPassword",
      });
    }
    expect(completeSetup).not.toHaveBeenCalled();

    // The same IP still has its whole budget for real token checks.
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await check({ data: { token: "WRONG" } })).kind).toBe(
        "invalid-token",
      );
    }
    expect((await check({ data: { token: "WRONG" } })).kind).toBe(
      "rate-limited",
    );
    expect((await complete({ data: input() })).kind).toBe("rate-limited");
  });
});
