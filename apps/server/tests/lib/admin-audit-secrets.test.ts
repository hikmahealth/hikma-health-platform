import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: { data: unknown; context: unknown }) => Promise<unknown>;

const { registry, logAdminAudit } = vi.hoisted(() => ({
  registry: [] as { method: string; handler: Handler; file: string }[],
  logAdminAudit: vi.fn(),
}));

// Route files keep their server functions private, so each one is captured
// here in declaration order.
vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-start")>();
  return {
    ...actual,
    createServerFn: (options?: { method?: string }) => {
      const builder = {
        validator: () => builder,
        middleware: () => builder,
        handler: (handler: Handler) => {
          // The declaring module, so a route's imports are not mixed in.
          const file = /\/src\/([^:?]+)/.exec(new Error().stack ?? "")?.[1];
          registry.push({
            method: options?.method ?? "GET",
            handler,
            file: file ?? "",
          });
          return handler;
        },
      };
      return builder;
    },
    createServerOnlyFn: (fn: unknown) => fn,
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/db", () => ({ default: {} }));
vi.mock("@/middleware/auth", () => ({
  adminMiddleware: {},
  permissionsMiddleware: {},
  superAdminMiddleware: {},
}));
vi.mock("@/lib/server-functions/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server-functions/audit")>()),
  logAdminAudit,
}));

import User from "@/models/user";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import Device from "@/models/device";
import AppConfig from "@/models/app-config";
import ServerVariable from "@/models/server_variable";

const SECRET = "s3cret-value-that-must-not-be-logged";
const ACTOR = { userId: "actor-1", role: User.ROLES.SUPER_ADMIN };

/** The POST handlers `file` declares, in order; `count` guards against reorders. */
const postHandlers = async (
  file: string,
  load: () => Promise<unknown>,
  count: number,
) => {
  await load();
  const handlers = registry
    .filter((entry) => entry.method === "POST" && entry.file === file)
    .map((entry) => entry.handler);
  expect(handlers).toHaveLength(count);
  return handlers;
};

const logged = () => JSON.stringify(logAdminAudit.mock.calls);

beforeEach(() => {
  vi.restoreAllMocks();
  logAdminAudit.mockClear();
  vi.spyOn(
    UserClinicPermissions.API,
    "isAuthorizedWithClinic",
  ).mockResolvedValue(true as never);
});

describe("admin audit rows never carry secrets", () => {
  it("user creation and edits record no password", async () => {
    const [updateUser, registerUser] = await postHandlers(
      "routes/app/users.edit.$.tsx",
      () => import("@/routes/app/users.edit.$"),
      2,
    );
    const user = {
      id: "user-1",
      name: "Nurse Joy",
      email: "joy@example.org",
      role: "provider",
      clinic_id: "clinic-1",
      hashed_password: SECRET,
    };
    vi.spyOn(User.API, "create").mockResolvedValue("user-1");
    vi.spyOn(User.API, "update").mockResolvedValue("user-1");
    vi.spyOn(User.API, "getById").mockResolvedValue({
      ...user,
      hashed_password: SECRET,
      role: "registrar",
    } as never);

    await registerUser({
      data: { user, creatorId: "actor-1" },
      context: ACTOR,
    });
    await updateUser({ data: { id: "user-1", user }, context: ACTOR });

    expect(logAdminAudit).toHaveBeenCalledTimes(2);
    expect(logged()).not.toContain(SECRET);
    expect(logAdminAudit.mock.calls[1][1].changes).toMatchObject({
      role: { old: "registrar", new: "provider" },
    });
  });

  it("a password reset records that it happened, not the password", async () => {
    vi.spyOn(User.API, "updatePassword").mockResolvedValue("user-1");
    const { resetUserPassword } = await import("@/lib/server-functions/users");

    await (resetUserPassword as unknown as Handler)({
      data: { userId: "user-1", password: SECRET },
      context: ACTOR,
    });

    expect(logAdminAudit).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(SECRET);
  });

  it("device registration and key rotation record no API key", async () => {
    const [registerDevice, , regenerateDeviceApiKey] = await postHandlers(
      "routes/app/settings.devices.edit.$.tsx",
      () => import("@/routes/app/settings.devices.edit.$"),
      3,
    );
    vi.spyOn(Device.API, "register").mockResolvedValue({
      id: "device-1",
      api_key: SECRET,
    });
    vi.spyOn(Device.API, "regenerateApiKey").mockResolvedValue({
      api_key: SECRET,
    });

    const registered = await registerDevice({
      data: { name: "Tablet", device_type: "mobile_app", clinic_ids: [] },
      context: ACTOR,
    });
    await regenerateDeviceApiKey({ data: { id: "device-1" }, context: ACTOR });

    expect(registered).toMatchObject({ api_key: SECRET });
    expect(logAdminAudit).toHaveBeenCalledTimes(2);
    expect(logged()).not.toContain(SECRET);
  });

  it("configuration and server variables record key names, not values", async () => {
    const handlers = await postHandlers(
      "routes/app/settings.configurations.index.tsx",
      () => import("@/routes/app/settings.configurations.index"),
      5,
    );
    const [saveConfiguration, , , , upsertServerVariable] = handlers;
    vi.spyOn(AppConfig.API, "set").mockResolvedValue({} as never);
    vi.spyOn(ServerVariable, "update").mockResolvedValue("ok");

    await saveConfiguration({
      data: {
        namespace: "integrations",
        key: "api-token",
        displayName: null,
        value: SECRET,
        dataType: "string",
        updatedBy: "actor-1",
      },
      context: ACTOR,
    });
    await upsertServerVariable({
      data: {
        key: "storage-secret",
        value_type: "string",
        value_data: new TextEncoder().encode(SECRET),
        value_hash: SECRET,
      },
      context: ACTOR,
    });

    expect(logAdminAudit).toHaveBeenCalledTimes(2);
    expect(logged()).not.toContain(SECRET);
    expect(logged()).toContain("api-token");
    expect(logged()).toContain("storage-secret");
  });
});
