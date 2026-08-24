import { createMiddleware } from "@tanstack/react-start";
import { deleteCookie } from "@tanstack/react-start/server";
import { getCookieToken } from "@/lib/auth/request";
import Token from "@/models/token";
import { Option, pipe } from "effect";
import User from "@/models/user";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import * as Sentry from "@sentry/tanstackstart-react";
import type Clinic from "@/models/clinic";
import { Logger } from "@hikmahealth/js-utils";

/** Middleware that rejects requests from users who are not super_admin. */
export const superAdminMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const token = getCookieToken();
  if (!token) {
    throw new Error("Unauthorized: no session token");
  }

  const caller = await Token.getUser(token);

  if (Option.isNone(caller)) {
    deleteCookie("token");
  }

  const role = Option.map(caller, (c) => c.role);

  if (Option.isNone(role) || role.value !== User.ROLES.SUPER_ADMIN) {
    throw new Error("Unauthorized: super_admin role required");
  }

  return next({
    context: {
      userId: Option.getOrNull(Option.map(caller, (c) => c.id)),
    },
  });
});

/**
 * Middleware that rejects requests from users who are not admin or super_admin.
 * The default gate for server functions — the web app is an administrative
 * surface; providers and registrars use mobile.
 *
 * Throws rather than passing a flag downstream, so an endpoint that forgets to
 * check its context still fails closed.
 */
export const adminMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  const token = getCookieToken();
  if (!token) {
    throw new Error("Unauthorized: no session token");
  }

  const caller = await Token.getUser(token);

  if (Option.isNone(caller)) {
    deleteCookie("token");
  }

  const role = Option.map(caller, (c) => c.role);

  // None is checked explicitly so an absent role can't pass by comparing
  // undefined against the allowed values.
  if (
    Option.isNone(role) ||
    (role.value !== User.ROLES.ADMIN && role.value !== User.ROLES.SUPER_ADMIN)
  ) {
    throw new Error("Unauthorized: admin role required");
  }

  return next({
    context: {
      userId: Option.getOrNull(Option.map(caller, (c) => c.id)),
      role: role.value,
    },
  });
});

export const authMiddleware = createMiddleware({ type: "function" })
  .validator(
    (data: { capabilities?: (typeof User.CapabilitySchema.Type)[] }) => data,
  )
  .server(async ({ next, data, context }) => {
    Logger.log({
      msg: "context around authMiddleware",
      data: { context, data },
    });

    const { capabilities } = data;

    const token = getCookieToken();
    if (!token) {
      return next({
        context: {
          isAuthorized: false,
        },
      });
    }
    const caller = await Token.getUser(token);

    const isAuthorized = Option.match(caller, {
      onNone: () => {
        deleteCookie("token");
        return false;
      },
      onSome: (caller) => {
        const roleCapabilities = User.ROLE_CAPABILITIES[caller.role] || [];
        if (
          capabilities &&
          !capabilities.every((capability) =>
            roleCapabilities.includes(capability),
          )
        ) {
          return false;
        }
        return true;
      },
    });

    return next({
      context: {
        isAuthorized,
      },
    });
  });

// FIXME: Update capabilities to use the user-clinic-permissions in addition to the user roles
/**
 * @deprecated
 */
export const capabilitiesMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  Logger.log("Calling capabilities middlware");
  const token = getCookieToken();
  if (!token) {
    return next({
      context: {
        capabilities: [] as (typeof User.CapabilitySchema.Type)[],
      },
    });
  }
  const caller = await Token.getUser(token);
  const capabilities = Option.match(caller, {
    onNone: () => {
      deleteCookie("token");
      return [] as (typeof User.CapabilitySchema.Type)[];
    },
    onSome: (caller) => User.ROLE_CAPABILITIES[caller.role] || [],
  });
  return next({
    context: {
      capabilities: capabilities as (typeof User.CapabilitySchema.Type)[],
    },
  });
});

export const permissionsMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  Logger.log("Calling permssions middlware");
  return Sentry.startSpan(
    { name: "Getting user clinic permissions" },
    async () => {
      const token = getCookieToken();

      if (!token) {
        type ClinicId = Clinic.EncodedT["id"];
        return next({
          context: {
            userId: null as string | null,
            permissions: {} as Record<ClinicId, UserClinicPermissions.EncodedT>,
            role: null as typeof User.RoleSchema.Type | null,
          },
        });
      }

      const caller = await Token.getUser(token);
      const permissionsArray = await Option.match(caller, {
        onNone: async () => {
          deleteCookie("token");
          return [] as UserClinicPermissions.EncodedT[];
        },
        onSome: async (caller) => {
          return await UserClinicPermissions.API.getByUser(caller.id);
        },
      });

      // Transform array to object keyed by clinic_id
      const permissions = permissionsArray.reduce(
        (acc, permission) => {
          acc[permission.clinic_id] = permission;
          return acc;
        },
        {} as Record<Clinic.EncodedT["id"], UserClinicPermissions.EncodedT>,
      );

      return next({
        context: {
          // userId: Option.getOrNull(caller)?.id || null,
          userId: pipe(
            caller,
            Option.map((c) => c.id),
            Option.getOrNull,
          ),
          permissions,
          role: pipe(
            caller,
            Option.map((c) => c.role),
            Option.getOrNull,
          ),
        },
      });
    },
  );
});
