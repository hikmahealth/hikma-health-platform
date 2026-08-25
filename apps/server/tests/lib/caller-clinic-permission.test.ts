import { describe, it, expect, vi, beforeEach } from "vitest";

const { getScopedValue, getClinicIdsWithPermission } = vi.hoisted(() => ({
  getScopedValue: vi.fn(),
  getClinicIdsWithPermission: vi.fn(),
}));

vi.mock("@/models/app-config", () => ({
  default: {
    Namespaces: { AUTH: "auth" },
    API: { getScopedValue },
  },
}));

vi.mock("@/models/user-clinic-permissions", () => ({
  default: {
    API: { getClinicIdsWithPermission },
    userPermissions: {
      CAN_VIEW_HISTORY: "can_view_history",
      CAN_REGISTER_PATIENTS: "can_register_patients",
    },
  },
}));

import { callerHasClinicPermission } from "@/lib/mobile-permissions";

const ask = (allowMobileOverride: boolean) =>
  callerHasClinicPermission({
    userId: "user-1",
    clinicId: "clinic-a",
    permission: "can_view_history",
    allowMobileOverride,
  });

describe("callerHasClinicPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("with the admin override on", () => {
    beforeEach(() => {
      getScopedValue.mockResolvedValue(true);
      getClinicIdsWithPermission.mockResolvedValue([]);
    });

    it("allows a session caller holding no permissions at all", async () => {
      await expect(ask(true)).resolves.toBe(true);
    });

    it("does not query permissions it has already stopped needing", async () => {
      await ask(true);
      expect(getClinicIdsWithPermission).not.toHaveBeenCalled();
    });

    // The grant token ships inside an exported workbook.
    it("still denies an ineligible caller", async () => {
      await expect(ask(false)).resolves.toBe(false);
    });

    it("keeps an ineligible caller's own permissions working", async () => {
      getClinicIdsWithPermission.mockResolvedValue(["clinic-a"]);
      await expect(ask(false)).resolves.toBe(true);
    });

    it("reads the flag for the clinic under decision", async () => {
      await ask(true);
      expect(getScopedValue).toHaveBeenCalledWith(
        "auth",
        "disable-mobile-permissions-checking",
        "clinic-a",
      );
    });
  });

  describe("with the admin override off", () => {
    it.each([[false], [null], [undefined]])(
      "denies an ungranted session caller when the flag reads %o",
      async (value) => {
        getScopedValue.mockResolvedValue(value);
        getClinicIdsWithPermission.mockResolvedValue([]);
        await expect(ask(true)).resolves.toBe(false);
      },
    );

    it("allows a granted session caller", async () => {
      getScopedValue.mockResolvedValue(false);
      getClinicIdsWithPermission.mockResolvedValue(["clinic-b", "clinic-a"]);
      await expect(ask(true)).resolves.toBe(true);
    });

    it("denies a caller granted only elsewhere", async () => {
      getScopedValue.mockResolvedValue(false);
      getClinicIdsWithPermission.mockResolvedValue(["clinic-b"]);
      await expect(ask(true)).resolves.toBe(false);
    });
  });

  // A row scoped to other clinics reads as null, i.e. "not overridden".
  it("falls back to permissions when the flag row excludes this clinic", async () => {
    getScopedValue.mockResolvedValue(null);
    getClinicIdsWithPermission.mockResolvedValue(["clinic-a"]);
    await expect(ask(true)).resolves.toBe(true);

    getClinicIdsWithPermission.mockResolvedValue([]);
    await expect(ask(true)).resolves.toBe(false);
  });

  it("accepts the flag stored as the string \"true\"", async () => {
    getScopedValue.mockResolvedValue("true");
    getClinicIdsWithPermission.mockResolvedValue([]);
    await expect(ask(true)).resolves.toBe(true);
  });
});
