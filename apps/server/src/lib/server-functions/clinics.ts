import { createServerFn } from "@tanstack/react-start";
import Clinic from "@/models/clinic";
import User from "@/models/user";
import * as Sentry from "@sentry/tanstackstart-react";
import ClinicDepartment from "@/models/clinic-department";
import {
  adminMiddleware,
  permissionsMiddleware,
  superAdminMiddleware,
} from "@/middleware/auth";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import { Result } from "@/lib/result";
import { Logger } from "@hikmahealth/js-utils";

export const getAllClinics = createServerFn({ method: "GET" })
  .middleware([permissionsMiddleware])
  .handler(async ({ context }) => {
    // Returns an error Result instead of throwing: this runs in the /app layout
    // loader, where a throw takes down every page rather than one widget.
    if (
      !context.userId ||
      (context.role !== User.ROLES.ADMIN &&
        context.role !== User.ROLES.SUPER_ADMIN)
    ) {
      return Result.err({
        _tag: "Unauthorized" as const,
        message: "Unauthorized: admin role required",
      });
    }
    return Sentry.startSpan({ name: "Get all clinics" }, async () => {
      try {
        const clinics = await Clinic.getAll();
        return Result.ok(clinics);
      } catch (error) {
        Sentry.captureException(error);
        return Result.err({
          _tag: "ServerError" as const,
          message:
            error instanceof Error ? error.message : "Failed to fetch clinics",
        });
      }
    });
  });

export const getClinicById = createServerFn({
  method: "GET",
})
  .validator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    const clinicId = data.id;
    return await Sentry.startSpan({ name: "getClinicById" }, async () => {
      try {
        const clinic = await Clinic.getById(clinicId);
        const departments =
          await ClinicDepartment.API.getActiveByClinicId(clinicId);
        return Result.ok({
          clinic: clinic as Clinic.EncodedT,
          departments: departments as ClinicDepartment.EncodedT[],
        });
      } catch (error) {
        Sentry.captureException(error);
        Logger.error({ msg: "Error fetching clinic:", error });
        return Result.err({
          _tag: "ServerError" as const,
          message:
            error instanceof Error ? error.message : "Error fetching clinic",
        });
      }
    });
  });

export const createDepartment = createServerFn({ method: "POST" })
  .validator(
    (data: {
      clinicId: string;
      name: string;
      code?: string;
      description?: string;
      can_dispense_medications: boolean;
      can_perform_labs: boolean;
    }) => data,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    const departmentId = await ClinicDepartment.API.upsert({
      clinic_id: data.clinicId,
      name: data.name,
      code: data.code || null,
      description: data.description || null,
      status: ClinicDepartment.STATUS.ACTIVE,
      can_dispense_medications: data.can_dispense_medications,
      can_perform_labs: data.can_perform_labs,
      can_perform_imaging: false,
      additional_capabilities: [],
      metadata: {},
      is_deleted: false,
    });

    return { success: true, departmentId };
  });

export const toggleDepartmentCapability = createServerFn({ method: "POST" })
  .validator(
    (data: {
      clinicId: string;
      departmentId: string;
      capability: ClinicDepartment.DepartmentCapability;
    }) => data,
  )
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (!context.userId) {
      return Promise.reject({
        message: "Unauthorized: Isufficient permissions",
        source: "deleteDepartment",
      });
    }

    await UserClinicPermissions.API.isAuthorizedWithClinic(
      data.clinicId,
      "is_clinic_admin",
    );
    const { departmentId, capability } = data;

    return await ClinicDepartment.API.toggleCapability(
      departmentId,
      capability,
    );
  });

export const deleteDepartment = createServerFn({ method: "POST" })
  .validator((data: { clinicId: string; departmentId: string }) => data)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (!context.userId) {
      return Promise.reject({
        message: "Unauthorized: Isufficient permissions",
        source: "deleteDepartment",
      });
    }

    await UserClinicPermissions.API.isAuthorizedWithClinic(
      data.clinicId,
      "is_clinic_admin",
    );
    const { departmentId } = data;

    return await ClinicDepartment.API.softDelete(departmentId);
  });
