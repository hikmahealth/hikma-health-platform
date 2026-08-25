import { createServerOnlyFn } from "@tanstack/react-start";
import AppConfig from "@/models/app-config";
import UserClinicPermissions from "@/models/user-clinic-permissions";

/**
 * Admin switch under Settings → Configurations ("Override Mobile Permissions").
 * When set, mobile treats every clinic as permitted, so the endpoints devices
 * call must do the same or the app offers actions the server then rejects.
 */
export const MOBILE_PERMISSIONS_OVERRIDE_KEY =
  "disable-mobile-permissions-checking";

/** Stored as a boolean, but hand-written rows land it as the string "true". */
export const isOverrideEnabled = (value: unknown): boolean =>
  value === true || value === "true";

/** Whether a caller may act on `clinicId`, given the override and their grants. */
export const allowsClinic = (
  overridden: boolean,
  permittedClinicIds: readonly string[],
  clinicId: string,
): boolean => overridden || permittedClinicIds.includes(clinicId);

/**
 * Whether the override applies to a clinic. The settings UI writes an unscoped
 * row, so this is `true` everywhere unless `clinic_ids` was narrowed by hand.
 */
export const isMobilePermissionCheckingDisabled = createServerOnlyFn(
  async (clinicId: string | null): Promise<boolean> => {
    const value = await AppConfig.API.getScopedValue(
      AppConfig.Namespaces.AUTH,
      MOBILE_PERMISSIONS_OVERRIDE_KEY,
      clinicId,
    );
    return isOverrideEnabled(value);
  },
);

/**
 * Whether a caller holds `permission` at `clinicId`.
 *
 * `allowMobileOverride` is required rather than defaulted so a new route cannot
 * inherit the override silently. Pass false for any credential that travels
 * outside the app, such as an access-grant token.
 */
export const callerHasClinicPermission = createServerOnlyFn(
  async (params: {
    userId: string;
    clinicId: string;
    permission: UserClinicPermissions.UserPermissionsT;
    allowMobileOverride: boolean;
  }): Promise<boolean> => {
    const overridden =
      params.allowMobileOverride &&
      (await isMobilePermissionCheckingDisabled(params.clinicId));

    // Empty because the override decides it, not because the caller holds nothing.
    const permittedClinicIds = overridden
      ? []
      : await UserClinicPermissions.API.getClinicIdsWithPermission(
          params.userId,
          params.permission,
        );

    return allowsClinic(overridden, permittedClinicIds, params.clinicId);
  },
);
