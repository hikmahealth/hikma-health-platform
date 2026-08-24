import { createServerFn } from "@tanstack/react-start";
import User from "@/models/user";
import { permissionsMiddleware } from "@/middleware/auth";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import { getCookie } from "@tanstack/react-start/server";
import Token from "@/models/token";
import { Option } from "effect";
import { userRoleTokenHasCapability } from "@/lib/auth/request";
import { adminMiddleware } from "@/middleware/auth";
// import Patient from "@/models/patient";

/**
 * Authorization gate for `getAllUsers`, exported only so tests can reach it
 * without the createServerFn middleware chain.
 *
 * Fails closed with `[]` rather than throwing, matching `searchPatients`: the
 * prescriptions and appointments edit loaders call this and would otherwise
 * crash for registrars.
 */
export const getAllUsersImpl = async (): Promise<User.EncodedT[]> => {
  const authorized = await userRoleTokenHasCapability([
    User.CAPABILITIES.READ_USER,
  ]);
  if (!authorized) return [];
  return await User.API.getAll();
};

/** All users, or `[]` when the caller lacks READ_USER. */
export const getAllUsers = createServerFn({ method: "GET" }).handler(
  getAllUsersImpl,
);

/**
 * Gets clinic IDs where a specific user has a given permission
 * @param data.userId - The ID of the user to check permissions for
 * @param data.permission - The specific permission type to check
 * @returns Array of clinic IDs where the user has the specified permission
 */
export const getClinicIdsWithUserPermission = createServerFn({ method: "GET" })
  .validator(
    (data: {
      userId: string;
      permission: UserClinicPermissions.UserPermissionsT;
    }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    const user = await User.API.getById(data.userId);
    if (!user) return [];
    const permissions =
      await UserClinicPermissions.API.getClinicIdsWithPermission(
        user.id,
        data.permission,
      );
    return permissions;
  });

/**
 * Retrieve a user by id. Returns null when no id is given or the user has no
 * clinic; rejects unless the caller is a super admin or an admin of that
 * user's clinic.
 */
export const getUserById = createServerFn({ method: "GET" })
  .validator((data: { id?: string | null } = {}) => data)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (!context.userId) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "getUserById",
      });
    }

    if (!data?.id) return null;

    const res = await User.API.getById(data.id);

    const clinicId = res?.clinic_id;
    if (!clinicId) return null;

    // check if the user is a super admin, is the owner of the user requested or is an admin of the clinic
    if (
      context.role === User.ROLES.SUPER_ADMIN ||
      context.permissions[clinicId]?.is_clinic_admin
    ) {
      return res;
    } else {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "getUserById",
      });
    }
  });

/** Whether the session cookie's user holds `data.role`. */
export const currentUserHasRole = createServerFn({ method: "GET" })
  .validator((data: { role: User.RoleT }) => data)
  .handler(async ({ data }) => {
    const tokenCookie = getCookie("token");
    if (!tokenCookie) return false;

    const userOption = await Token.getUser(tokenCookie);
    const user = Option.match(userOption, {
      onNone: () => null,
      onSome: (user) => user,
    });

    if (!user) return false;
    return user.role === data.role;
  });

/** All clinic permissions for `data.userId`. */
export const getUserClinicPermissions = createServerFn({ method: "GET" })
  .validator((data: { userId: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return await UserClinicPermissions.API.getByUser(data.userId);
  });

/** Reset a user's password. Rejects unless the caller is a super admin. */
export const resetUserPassword = createServerFn({ method: "POST" })
  .validator((data: { userId: string; password: string }) => data)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: SUPER_ADMIN role required",
        source: "resetUserPassword",
      });
    }

    return await User.API.updatePassword(data.userId, data.password);
  });
