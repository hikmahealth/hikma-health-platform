import { createServerFn } from "@tanstack/react-start";
import Prescription from "@/models/prescription";
import Patient from "@/models/patient";
import Clinic from "@/models/clinic";
import User from "@/models/user";
import { userRoleTokenHasCapability } from "../auth/request";
import type { Pagination } from "./builders";
import * as Sentry from "@sentry/tanstackstart-react";
import { Result } from "@/lib/result";
import { adminMiddleware } from "@/middleware/auth";

const getAllPrescriptions = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Prescription.EncodedT[]> => {
    const res = await Prescription.API.getAll();
    return res;
  });

const getAllPrescriptionsWithDetails = createServerFn({
  method: "GET",
})
  .middleware([adminMiddleware])
  .handler(
    async (): Promise<
      {
        prescription: Prescription.EncodedT;
        patient: Patient.EncodedT;
        clinic: Clinic.EncodedT;
        provider: User.EncodedT;
      }[]
    > => {
      const res = await Prescription.API.getAllWithDetails();
      return res;
    },
  );

const togglePrescriptionStatus = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string; status: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<void> => {
    await Prescription.API.toggleStatus(data.id, data.status);
  });

/**
 * Get paginated prescriptions for a patient.
 */
const getPatientPrescriptions = createServerFn({ method: "GET" })
  .inputValidator(
    (data: { patientId: string; offset?: number; limit?: number }) => data,
  )
  .handler(
    async ({
      data,
    }): Promise<
      Result<{
        items: Prescription.EncodedT[];
        statusCounts: Prescription.StatusCount[];
        pagination: Pagination;
      }>
    > => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.READ_ALL_PATIENT,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "getPatientPrescriptions",
        });
      }

      try {
        const result = await Prescription.API.getByPatientId({
          patientId: data.patientId,
          limit: data.limit ?? 10,
          offset: data.offset ?? 0,
          includeCount: true,
        });

        return Result.ok({
          items: result.items,
          statusCounts: result.statusCounts,
          pagination: result.pagination,
        });
      } catch (error) {
        Sentry.captureException(error);
        return Result.err({
          _tag: "ServerError" as const,
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch prescriptions",
        });
      }
    },
  );

export {
  getAllPrescriptions,
  getAllPrescriptionsWithDetails,
  togglePrescriptionStatus,
  getPatientPrescriptions,
};
