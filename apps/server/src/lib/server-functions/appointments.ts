import { createServerFn } from "@tanstack/react-start";
import Appointment from "@/models/appointment";
import type User from "@/models/user";
import { adminMiddleware } from "@/middleware/auth";

export const getAllAppointments = createServerFn({ method: "GET" })
  .middleware([adminMiddleware])
  .handler(async (): Promise<Appointment.EncodedT[]> => {
    const res = await Appointment.API.getAll();
    return res;
  });

export const getAppointmentById = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<Appointment.EncodedT | null> => {
    const res = await Appointment.API.getById(data.id);

    return res;
  });

/** A patient's appointments, earliest first. */
export const getAppointmentsByPatientId = createServerFn({ method: "GET" })
  .validator((data: { patientId: string }) => data)
  .middleware([adminMiddleware])
  .handler(
    async ({
      data,
    }): Promise<
      WithError<{
        data: {
          appointment: Appointment.EncodedT;
          patient: Patient.EncodedT;
          clinic: Clinic.EncodedT;
          provider: User.EncodedT | null;
        }[];
      }>
    > => {
      try {
        const res = await Appointment.API.getByPatientId(data.patientId);
        return {
          data: res || [],
          error: null,
        };
      } catch (error) {
        return {
          data: [],
          error: error as Error,
        };
      }
    },
  );

/** Every appointment joined to its patient, clinic and provider. */
export const getAllAppointmentsWithDetails = createServerFn({
  method: "GET",
})
  .middleware([adminMiddleware])
  .handler(
    async (): Promise<
      {
        appointment: Appointment.EncodedT;
        patient: Patient.EncodedT;
        clinic: Clinic.EncodedT;
        provider: User.EncodedT | null;
      }[]
    > => {
      const res = await Appointment.API.getAllWithDetails();
      return res;
    },
  );

export const toggleAppointmentStatus = createServerFn({ method: "POST" })
  .validator((data: { id: string; status: string }) => data)
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<void> => {
    await Appointment.API.toggleStatus(data.id, data.status);
  });
