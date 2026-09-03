import { createServerFn } from "@tanstack/react-start";
import Prescription from "@/models/prescription";
import User from "@/models/user";
import { userRoleTokenHasCapability } from "../auth/request";
import { pageOffset, type Pagination } from "./builders";
import * as Sentry from "@sentry/tanstackstart-react";
import { Result } from "@/lib/result";
import { adminMiddleware } from "@/middleware/auth";

const PRESCRIPTIONS_PAGE_SIZE = 25;

export type PrescriptionsPage = {
  items: Prescription.EncodedT[];
  pagination: Pagination;
};

/** One page of the all-patients prescription list. Pages are 1-based. */
const getPrescriptionsPage = createServerFn({ method: "GET" })
  .validator((data: { page?: number } | undefined) => data ?? {})
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<PrescriptionsPage> => {
    return Prescription.API.getPage({
      limit: PRESCRIPTIONS_PAGE_SIZE,
      offset: pageOffset(data.page ?? 1, PRESCRIPTIONS_PAGE_SIZE),
    });
  });

const togglePrescriptionStatus = createServerFn({ method: "POST" })
  .validator((data: { id: string; status: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<void> => {
    await Prescription.API.toggleStatus(data.id, data.status);
  });

/**
 * Get paginated prescriptions for a patient.
 */
const getPatientPrescriptions = createServerFn({ method: "GET" })
  .validator(
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
  getPrescriptionsPage,
  togglePrescriptionStatus,
  getPatientPrescriptions,
};
