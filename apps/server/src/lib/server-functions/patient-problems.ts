import { createServerFn } from "@tanstack/react-start";
import PatientProblem from "@/models/patient-problem";
import User from "@/models/user";
import { userRoleTokenHasCapability } from "../auth/request";
import type { Pagination } from "./builders";
import * as Sentry from "@sentry/tanstackstart-react";
import { Result } from "@/lib/result";

/**
 * Get paginated problems for a patient, most recently updated first.
 */
const getPatientProblems = createServerFn({ method: "GET" })
  .validator(
    (data: { patientId: string; offset?: number; limit?: number }) => data,
  )
  .handler(
    async ({
      data,
    }): Promise<
      Result<{
        items: PatientProblem.EncodedT[];
        pagination: Pagination;
      }>
    > => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.READ_ALL_PATIENT,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "getPatientProblems",
        });
      }

      try {
        const result = await PatientProblem.getByPatientIdPaginated({
          patientId: data.patientId,
          limit: data.limit ?? 5,
          offset: data.offset ?? 0,
          includeCount: true,
        });

        return Result.ok({ items: result.items, pagination: result.pagination });
      } catch (error) {
        Sentry.captureException(error);
        return Result.err({
          _tag: "ServerError" as const,
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch patient problems",
        });
      }
    },
  );

export { getPatientProblems };
