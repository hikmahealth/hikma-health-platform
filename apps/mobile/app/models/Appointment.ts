import { Model, Q } from "@nozbe/watermelondb"
import { Option, Schema } from "effect"

import database from "@/db"
import AppointmentModel from "@/db/model/Appointment"
import ClinicDepartmentModel from "@/db/model/ClinicDepartment"
import PatientModel from "@/db/model/Patient"
import VisitModel from "@/db/model/Visit"
import { buildPrefilter, tokenizeForSearch } from "@/utils/parsers"

import User from "./User"
import { Logger } from "@hikmahealth/js-utils"

namespace Appointment {
  export const Status = {
    PENDING: "pending",
    SCHEDULED: "scheduled",
    CHECKED_IN: "checked_in",
    IN_PROGRESS: "in_progress",
    CONFIRMED: "confirmed",
    CANCELLED: "cancelled",
    COMPLETED: "completed",
  } as const

  export const DepartmentStatusSchema = Schema.Union(
    Schema.Literal("pending"),
    Schema.Literal("scheduled"),
    Schema.Literal("checked_in"),
    Schema.Literal("in_progress"),
    Schema.Literal("completed"),
    Schema.Literal("cancelled"),
    Schema.Literal("checked_in"),
  )

  export const DepartmentSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    seen_at: Schema.OptionFromNullOr(Schema.String),
    seen_by: Schema.OptionFromNullOr(Schema.String),
    status: DepartmentStatusSchema,
  })

  export type EncodedDepartment = Schema.Schema.Type<typeof DepartmentSchema>
  export type EncodedDepartmentT = typeof DepartmentSchema.Encoded

  const departmentStatusValues: readonly string[] = [
    "pending",
    "scheduled",
    "checked_in",
    "in_progress",
    "completed",
    "cancelled",
  ]

  /**
   * Narrow a department status read back out of the free-form departments jsonb.
   * @param {string} status
   * @returns {EncodedDepartmentT["status"]} the status, or "pending" if unrecognised
   */
  export const asDepartmentStatus = (status: string): EncodedDepartmentT["status"] =>
    departmentStatusValues.includes(status) ? (status as EncodedDepartmentT["status"]) : "pending"

  export type Status = (typeof Status)[keyof typeof Status]

  export const statusList = Object.values(Status)

  export type StatusSummary = {
    total: number
    byStatus: Record<Status, number>
    /** Appointments whose status this build does not know about. */
    unrecognized: number
  }

  const statusValues: readonly string[] = statusList

  const isStatus = (status: string): status is Status => statusValues.includes(status)

  /**
   * Tally a set of appointment statuses into one count per status.
   *
   * `total` always equals the sum of `byStatus` plus `unrecognized`.
   * @param {readonly string[]} statuses one entry per appointment
   * @returns {StatusSummary}
   */
  export const summarizeStatuses = (statuses: readonly string[]): StatusSummary => {
    const byStatus = Object.fromEntries(statusList.map((status) => [status, 0])) as Record<
      Status,
      number
    >
    const summary: StatusSummary = { total: statuses.length, byStatus, unrecognized: 0 }

    for (const status of statuses) {
      if (isStatus(status)) {
        byStatus[status] += 1
      } else {
        summary.unrecognized += 1
      }
    }

    return summary
  }

  export type T = {
    id: string
    providerId: Option.Option<string>
    clinicId: string
    patientId: string
    userId: string
    currentVisitId: string
    fulfilledVisitId: Option.Option<string>
    timestamp: Date
    duration: number // in minutes
    reason: string
    notes: string
    status: Status
    isWalkIn: boolean
    // This is a hack!! TODO: must pick one.
    departments: (EncodedDepartment | EncodedDepartmentT)[]
    metadata: Record<string, any>
    isDeleted: boolean
    createdAt: Date
    updatedAt: Date
    deletedAt: Option.Option<Date>
  }

  export type DBAppointment = AppointmentModel
  export type EncodedT = Omit<
    T,
    "providerId" | "clinicId" | "deletedAt" | "fulfilledVisitId" | "departments"
  > & {
    providerId: string | null
    clinicId: string | null
    fulfilledVisitId: string | null
    deletedAt: Date | null
    departments: {
      id: string
      name: string
      seen_at: string | null // accepts ISO date
      seen_by: string | null
      status: string
    }[]
  }

  /** Default empty Appointmet Item */
  export const empty: EncodedT = {
    id: "",
    providerId: null,
    clinicId: null,
    patientId: "",
    userId: "",
    currentVisitId: "",
    fulfilledVisitId: null,
    timestamp: new Date(),
    duration: 15,
    reason: "",
    notes: "",
    status: Status.PENDING,
    isWalkIn: false,
    departments: [],
    metadata: {},
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  }

  export const encode = (appointment: T): EncodedT => {
    return {
      id: appointment.id,
      providerId: Option.getOrNull(appointment.providerId),
      clinicId: appointment.clinicId,
      patientId: appointment.patientId,
      userId: appointment.userId,
      currentVisitId: appointment.currentVisitId,
      fulfilledVisitId: Option.getOrNull(appointment.fulfilledVisitId),
      timestamp: appointment.timestamp,
      duration: appointment.duration,
      reason: appointment.reason,
      notes: appointment.notes,
      status: appointment.status,
      isWalkIn: appointment.isWalkIn,
      departments: appointment.departments.map((dept) => ({
        id: dept.id,
        name: dept.name,
        seen_at: Option.getOrNull(dept.seen_at),
        seen_by: Option.getOrNull(dept.seen_by),
        status: dept.status,
      })),
      metadata: appointment.metadata,
      isDeleted: appointment.isDeleted,
      createdAt: appointment.createdAt,
      updatedAt: appointment.updatedAt,
      deletedAt: Option.getOrNull(appointment.deletedAt),
    }
  }

  export const decode = (data: EncodedT): T => {
    return {
      id: data.id,
      providerId: Option.fromNullable(data.providerId),
      clinicId: data.clinicId || "",
      patientId: data.patientId,
      userId: data.userId,
      currentVisitId: data.currentVisitId,
      fulfilledVisitId: Option.fromNullable(data.fulfilledVisitId),
      timestamp: data.timestamp,
      duration: data.duration,
      reason: data.reason,
      notes: data.notes,
      status: data.status,
      isWalkIn: data.isWalkIn,
      departments: data.departments.map((dept) => ({
        id: dept.id,
        name: dept.name,
        seen_at: Option.fromNullable(dept.seen_at),
        seen_by: Option.fromNullable(dept.seen_by),
        status: dept.status as "pending" | "cancelled" | "completed" | "in_progress" | "checked_in",
      })),
      metadata: data.metadata,
      isDeleted: data.isDeleted,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      deletedAt: Option.fromNullable(data.deletedAt),
    }
  }

  export namespace DB {
    /**
     * Create an appointment
     * @param {Appointment} appointment
     * @returns {Promise<{appointmentId: string, visitId: string | undefined}>}
     */
    export const create = async (
      appointment: Appointment.T,
      provider: { id: string; name: string },
    ): Promise<{ appointmentId: string; visitId: string | undefined }> => {
      // Check that the patientid, userId, and clinicid are valid strings (shallow test, not a deep check for a valid uuid)
      if (
        !appointment.patientId ||
        !appointment.userId ||
        !appointment.clinicId ||
        typeof appointment.patientId !== "string" ||
        typeof appointment.userId !== "string" ||
        typeof appointment.clinicId !== "string" ||
        appointment.patientId.length <= 3 ||
        appointment.userId.length <= 3 ||
        appointment.clinicId.length <= 3
      ) {
        throw new Error("Invalid patientId, userId, or clinicId")
      }

      return await database.write(async () => {
        let visit: VisitModel | null = null
        let appointmentVisitId: string | null = appointment.currentVisitId
        if (!appointment.currentVisitId) {
          visit = database.get<VisitModel>("visits").prepareCreate((newVisit) => {
            newVisit.patientId = appointment.patientId
            newVisit.clinicId = appointment.clinicId
            newVisit.providerId = provider.id
            newVisit.providerName = provider.name
            newVisit.checkInTimestamp = new Date()
            newVisit.metadata = {}
          })
          appointmentVisitId = visit.id
        }

        const appointmentQuery = database
          .get<AppointmentModel>("appointments")
          .prepareCreate((newAppointment) => {
            newAppointment.currentVisitId = appointmentVisitId
            newAppointment.patientId = appointment.patientId
            newAppointment.providerId = Option.isOption(appointment.providerId)
              ? Option.getOrElse(appointment.providerId, () => "")
              : ""
            newAppointment.clinicId = appointment.clinicId
            newAppointment.userId = provider.id
            newAppointment.timestamp = appointment.timestamp.getTime()
            newAppointment.duration = appointment.duration
            newAppointment.reason = appointment.reason || ""
            newAppointment.notes = appointment.notes || ""
            newAppointment.status = appointment.status || "pending"
            newAppointment.isWalkIn = appointment.isWalkIn || false
            newAppointment.departments = appointment.departments || []
            newAppointment.metadata = appointment.metadata || {}
            newAppointment.isDeleted = false
          })

        // Touching the patient metadata is what keeps the patient synced to the server
        // alongside the appointment.
        const patient = await database.get<PatientModel>("patients").find(appointment.patientId)
        let patientUpdate: PatientModel | undefined = undefined
        if (patient) {
          patientUpdate = patient.prepareUpdate((updatedPatient) => {
            updatedPatient.metadata = {
              ...updatedPatient.metadata,
              lastAppointmentTimestamp: appointment.timestamp.toISOString(),
            }
          })
        }

        await database.batch([visit, appointmentQuery, patientUpdate].filter(Boolean) as Model[])

        return {
          appointmentId: appointmentQuery.id,
          visitId: visit?.id,
        }
      })
    }

    /**
     * Mark an appointment as cancelled
     * @param {string} appointmentId
     * @returns {Promise<void>}
     */
    export const cancel = async (appointmentId: string): Promise<void> => {
      await database.write(async () => {
        const appointment = await database.get<AppointmentModel>("appointments").find(appointmentId)
        await appointment.update((appointment) => {
          appointment.status = "cancelled"
        })
      })
    }

    /**
     * Mark an appointment as complete
     * @param {string} appointmentId
     * Optional visitId to mark appointment as complete with respect to a visit
     * @param {string} visitId
     * @param {{ preserveStatus: boolean }} options - whether or not to preserve the status
     * @returns {Promise<void>}
     */
    export const markComplete = async (
      appointmentId: string,
      userId: string,
      visitId?: string,
      options?: { preserveStatus: boolean },
    ): Promise<void> => {
      await database.write(async () => {
        const appointment = await database.get<AppointmentModel>("appointments").find(appointmentId)
        await appointment.update((appointment) => {
          if (!options?.preserveStatus) {
            appointment.status = "completed"
          }
          appointment.fulfilledVisitId = visitId || null
          appointment.providerId = userId
        })
      })
    }

    /**
     * Update an appointment
     * @param {string} appointmentId
     * @param {Partial<Appointment>} appointment
     * @returns {Promise<void>}
     */
    export const update = async (
      appointmentId: string,
      appointment: Partial<Appointment.T>,
    ): Promise<void> => {
      await database.write(async () => {
        const appointmentRecord = await database
          .get<Appointment.DBAppointment>("appointments")
          .find(appointmentId)
        await appointmentRecord.update((appt) => {
          if (appointment.timestamp !== undefined)
            appt.timestamp = new Date(appointment.timestamp).getTime()
          if (appointment.duration !== undefined) appt.duration = appointment.duration
          if (appointment.reason !== undefined) appt.reason = appointment.reason
          if (appointment.notes !== undefined) appt.notes = appointment.notes
          if (appointment.status !== undefined) appt.status = appointment.status
          if (appointment.isWalkIn !== undefined) appt.isWalkIn = appointment.isWalkIn
          if (appointment.departments !== undefined) appt.departments = appointment.departments
          if (appointment.metadata !== undefined) appt.metadata = appointment.metadata
        })
      })
    }

    /**
     * Update the status of a departments appointment.
     * Only one department can be in_progress at a time. Therefore, if a deparment is in_progress reject the request with an error message.
     *
     * If the new status is "in_progress", the current time is set for the department seen_at.
     * If the new status is "completed", the userId is what is set for the department seen_by.
     * @param {string} appointmentId
     * @param {string} departmentId
     * @param {string} userId the id of the provider updating the status
     * @param {"checked_in" | "in_progress" | "completed"} status
     * @return {Promise<void>}
     */
    export const updateAppointmentDepartmentStatus = async (
      appointmentId: string,
      departmentId: string,
      userId: string,
      status: "checked_in" | "in_progress" | "completed" | "cancelled",
    ): Promise<void> => {
      await database.write(async () => {
        const appointment = await database.get<AppointmentModel>("appointments").find(appointmentId)

        const departmentIndex = appointment.departments.findIndex(
          (dept) => dept.id === departmentId,
        )

        let departmentName: string | undefined

        if (departmentIndex === -1) {
          const clinicDepartment = await database
            .get<ClinicDepartmentModel>("clinic_departments")
            .find(departmentId)

          departmentName = clinicDepartment.name
        }

        if (status === "in_progress") {
          const hasOtherInProgress = appointment.departments.some(
            (dept) => dept.id !== departmentId && dept.status === "in_progress",
          )

          if (hasOtherInProgress) {
            throw new Error(
              "Another department is already in progress. Only one department can be in progress at a time.",
            )
          }
        }

        await appointment.update((appt) => {
          const updatedDepartments = [...appt.departments]

          if (departmentIndex === -1) {
            const newDepartment: EncodedDepartmentT = {
              id: departmentId,
              name: departmentName!,
              seen_at: status === "in_progress" ? new Date().toISOString() : null,
              seen_by: status === "completed" ? userId : null,
              status: status,
            }
            updatedDepartments.push(newDepartment)
          } else {
            const departmentToUpdate = {
              ...updatedDepartments[departmentIndex],
              status: status,
            }

            if (status === "in_progress") {
              departmentToUpdate.seen_at = new Date().toISOString()
            }

            if (status === "completed") {
              departmentToUpdate.seen_by = userId
            }

            updatedDepartments[departmentIndex] = departmentToUpdate
          }

          appt.departments = updatedDepartments
          appt.providerId = userId
        })
      })
    }

    export const createSearchQueryConditions = (
      searchQuery: string,
      clinicIds: string[],
      status: string[],
      date: Date,
      options: { offset?: number; limit?: number } = { offset: 0, limit: 25 },
    ): Q.Clause[] => {
      // An empty `clinicIds` correctly matches nothing: no clinic satisfies the
      // filters, so no appointments should show.
      const conditions = [Q.where("clinic_id", Q.oneOf(clinicIds)), Q.where("is_deleted", false)]

      const startOfDay = new Date(date)
      startOfDay.setHours(0, 0, 0, 0)
      const endOfDay = new Date(date)
      endOfDay.setHours(23, 59, 59, 999)

      conditions.push(
        Q.where("timestamp", Q.gte(startOfDay.getTime())),
        Q.where("timestamp", Q.lte(endOfDay.getTime())),
      )

      if (status.length > 0) {
        conditions.push(Q.where("status", Q.oneOf(status)))
      }

      const nameTokens = tokenizeForSearch(searchQuery)
      if (nameTokens.length > 0) {
        conditions.push(
          Q.experimentalJoinTables(["patients"]),
          Q.or(
            ...nameTokens.flatMap((token) => [
              Q.on("patients", "given_name", Q.like(buildPrefilter(token))),
              Q.on("patients", "surname", Q.like(buildPrefilter(token))),
            ]),
          ),
        )
      }

      // A zero limit is "no cap" — callers that need every match, such as the
      // counts behind the appointments list, pass it deliberately.
      const { offset = 0, limit = 25 } = options
      if (offset > 0) {
        conditions.push(Q.skip(offset))
      }
      if (limit > 0) {
        conditions.push(Q.take(limit))
      }

      return conditions
    }

    /**
     * Search for appointments by different parameters
     * @param {string} searchQuery
     * @param {string} clinicId
     * @param {string[]} departmentIds
     * @param {string[]} status the list of statuses that an appointment could have
     * @param {Date} date the date of the appointment
     * @param {{ offset?: number, limit?: number }} options
     */
    export const search = async (
      searchQuery: string,
      clinicId: string,
      departmentIds: string[],
      status: string[],
      date: Date,
      options: { offset?: number; limit?: number } = { offset: 0, limit: 50 },
    ): Promise<Appointment.T[]> => {
      try {
        const conditions = createSearchQueryConditions(
          searchQuery,
          [clinicId],
          status,
          date,
          options,
        )

        const appointments = await database
          .get<AppointmentModel>("appointments")
          .query(...conditions)
          .fetch()

        const results: Appointment.T[] = appointments.map(rawToT)

        // The department filter can't be expressed as a query condition.
        if (departmentIds.length > 0) {
          return results.filter((appointment) =>
            appointment.departments.some((dept) => departmentIds.includes(dept.id)),
          )
        }

        return results
      } catch (error) {
        Logger.error({ msg: "Error searching appointments:", error })
        throw error
      }
    }

    /**
     * Convert a stored appointment into the encoded shape the editor form works with.
     *
     * Nullable columns are coerced to their empty value — the form branches on
     * `isWalkIn` being exactly true or false, and a null hides the date inputs.
     * @param {AppointmentModel} rawAppointment
     * @returns {Appointment.EncodedT}
     */
    export function rawToEncoded(rawAppointment: AppointmentModel): Appointment.EncodedT {
      return {
        id: rawAppointment.id,
        providerId: rawAppointment.providerId,
        clinicId: rawAppointment.clinicId,
        patientId: rawAppointment.patientId,
        userId: rawAppointment.userId,
        currentVisitId: rawAppointment.currentVisitId,
        fulfilledVisitId: rawAppointment.fulfilledVisitId,
        timestamp: new Date(rawAppointment.timestamp),
        duration: rawAppointment.duration || 0,
        reason: rawAppointment.reason || "",
        notes: rawAppointment.notes || "",
        status: rawAppointment.status,
        isWalkIn: rawAppointment.isWalkIn === true,
        departments: rawAppointment.departments || [],
        metadata: rawAppointment.metadata || {},
        isDeleted: rawAppointment.isDeleted,
        createdAt: rawAppointment.createdAt,
        updatedAt: rawAppointment.updatedAt,
        deletedAt: rawAppointment.deletedAt || null,
      }
    }

    /**
     * Look up a single appointment.
     * @param {string} appointmentId
     * @returns {Promise<Appointment.EncodedT | null>} null when no such appointment exists
     */
    export const getEncodedById = async (
      appointmentId: string,
    ): Promise<Appointment.EncodedT | null> => {
      const [record] = await database
        .get<AppointmentModel>("appointments")
        .query(Q.where("id", appointmentId), Q.take(1))
        .fetch()

      return record ? rawToEncoded(record) : null
    }

    export function rawToT(rawAppointment: AppointmentModel): Appointment.T {
      return {
        id: rawAppointment.id,
        providerId: rawAppointment.providerId
          ? Option.some(rawAppointment.providerId)
          : Option.none(),
        clinicId: rawAppointment.clinicId,
        patientId: rawAppointment.patientId,
        userId: rawAppointment.userId,
        currentVisitId: rawAppointment.currentVisitId,
        fulfilledVisitId: rawAppointment.fulfilledVisitId
          ? Option.some(rawAppointment.fulfilledVisitId)
          : Option.none(),
        timestamp: new Date(rawAppointment.timestamp),
        duration: rawAppointment.duration || 0,
        reason: rawAppointment.reason,
        notes: rawAppointment.notes,
        status: rawAppointment.status,
        isWalkIn: rawAppointment.isWalkIn,
        // FIXME: look into this. either remove all Options at this level or figure something else out.
        departments: rawAppointment.departments,
        metadata: rawAppointment.metadata,
        isDeleted: rawAppointment.isDeleted,
        createdAt: rawAppointment.createdAt,
        updatedAt: rawAppointment.updatedAt,
        deletedAt: rawAppointment.deletedAt ? Option.some(rawAppointment.deletedAt) : Option.none(),
      }
    }
  }
}

export default Appointment
