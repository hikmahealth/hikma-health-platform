import { createServerFn } from "@tanstack/react-start";
import PatientVital from "@/models/patient-vital";
import { userRoleTokenHasCapability } from "../auth/request";
import User from "@/models/user";
import * as Sentry from "@sentry/tanstackstart-react";
import { Logger } from "@hikmahealth/js-utils";

export const getPatientVitals = createServerFn({
  method: "GET",
})
  .validator((data: { patientId: string }) => data)
  .handler(async ({ data }): Promise<PatientVital.EncodedT[]> => {
    return Sentry.startSpan({ name: "getPatientVitals" }, async () => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.READ_ALL_PATIENT,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "getPatientVitals",
        });
      }

      try {
        const vitals = await PatientVital.API.getByPatientId(data.patientId);
        return vitals;
      } catch (error) {
        Logger.error({ msg: "Failed to fetch patient vitals:", error });
        return Promise.reject({
          message: "Failed to fetch patient vitals",
        });
      }
    });
  });

export const getMostRecentVital = createServerFn({
  method: "GET",
})
  .validator((data: { patientId: string }) => data)
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: "getMostRecentVital" }, async () => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.READ_ALL_PATIENT,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "getMostRecentVital",
        });
      }

      try {
        const vital = await PatientVital.API.getMostRecent(data.patientId);
        return vital;
      } catch (error) {
        Logger.error({ msg: "Failed to fetch most recent vital:", error });
        return Promise.reject({
          message: "Failed to fetch most recent vital",
        });
      }
    });
  });

export const getVitalsByDateRange = createServerFn({
  method: "GET",
})
  .validator(
    (data: { patientId: string; startDate: string; endDate: string }) => data,
  )
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: "getVitalsByDateRange" }, async () => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.READ_ALL_PATIENT,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "getVitalsByDateRange",
        });
      }

      try {
        const vitals = await PatientVital.API.getByDateRange(
          data.patientId,
          new Date(data.startDate),
          new Date(data.endDate),
        );
        return vitals;
      } catch (error) {
        Logger.error({ msg: "Failed to fetch vitals by date range:", error });
        return Promise.reject({
          message: "Failed to fetch vitals by date range",
        });
      }
    });
  });

export const createPatientVital = createServerFn({
  method: "POST",
})
  .validator((data: PatientVital.Table.NewPatientVitals) => data)
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: "createPatientVital" }, async () => {
      const authorized = await userRoleTokenHasCapability([
        User.CAPABILITIES.CREATE_VITALS,
      ]);

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "createPatientVital",
        });
      }

      try {
        const vital = await PatientVital.API.save(data);
        return vital;
      } catch (error) {
        Logger.error({ msg: "Failed to create patient vital:", error });
        return Promise.reject({
          message: "Failed to create patient vital",
        });
      }
    });
  });
