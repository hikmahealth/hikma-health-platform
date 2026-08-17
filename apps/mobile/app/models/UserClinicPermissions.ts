import { Q } from "@nozbe/watermelondb"
import * as Sentry from "@sentry/react-native"
import { Option, Either } from "effect"
import { camelToSnake } from "effect/String"

import database from "@/db"
import ClinicModel from "@/db/model/Clinic"
import UserModel from "@/db/model/User"
import UserClinicPermissionModel from "@/db/model/UserClinicPermissions"
import { providerStore } from "@/store/provider"

import AppConfig from "./AppConfig"
import User from "./User"
import { ok, err, type Result, type DataError } from "../../types/data"
import { Logger } from "@hikmahealth/js-utils"

namespace UserClinicPermissions {
  export type T = {
    id: string
    userId: string
    clinicId: string
    canRegisterPatients: boolean // Whether or not a user can register a patient
    canViewHistory: boolean //Given a registered patient, can a provider view their history, including their patient files/charts
    canEditRecords: boolean // Whether or not they are allowed to edit any records of the patient at all
    canDeleteRecords: boolean // Whether or not they can delete patient records
    isClinicAdmin: boolean // Whether or not they are the clinic Admin. If they are a clinic Admin, they have all permissions for their given clinic. not for other clinics.
    canEditOtherProviderEvent: boolean // If a visit, event, appointment or prescription is made by a user that is not this user, can they edit it?
    canDownloadPatientReports: boolean // Whether or not the user can download the patient chart information
    canPrescribeMedications: boolean // Whether or not a user can prescribe patient medictications in the Medication screens and models
    canDispenseMedications: boolean // Given a medication prescription, can a user dispense the given medications?
    canDeletePatientVisits: boolean // Whether or not a user can delete any information of a patients visit history - this is not including the patient.
    canDeletePatientRecords: boolean // Whether or not a user can delete a patient and their chart
    createdBy: Option.Option<string>
    lastModifiedBy: Option.Option<string>
    createdAt: Date
    updatedAt: Date
  }

  export type UserPermissionsT = keyof Pick<
    T,
    | "canRegisterPatients"
    | "canViewHistory"
    | "canEditRecords"
    | "canDeleteRecords"
    | "isClinicAdmin"
    | "canEditOtherProviderEvent"
    | "canDownloadPatientReports"
    | "canPrescribeMedications"
    | "canDispenseMedications"
    | "canDeletePatientVisits"
    | "canDeletePatientRecords"
  >

  /** Maps a permission field to its snake_case database column. */
  export function getSQLPermissionName(permission: UserPermissionsT): string {
    switch (permission) {
      case "canRegisterPatients":
        return "can_register_patients"
      case "canViewHistory":
        return "can_view_history"
      case "canEditRecords":
        return "can_edit_records"
      case "canDeleteRecords":
        return "can_delete_records"
      case "isClinicAdmin":
        return "is_clinic_admin"
      case "canEditOtherProviderEvent":
        return "can_edit_other_provider_event"
      case "canDownloadPatientReports":
        return "can_download_patient_reports"
      case "canPrescribeMedications":
        return "can_prescribe_medications"
      case "canDispenseMedications":
        return "can_dispense_medications"
      case "canDeletePatientVisits":
        return "can_delete_patient_visits"
      case "canDeletePatientRecords":
        return "can_delete_patient_records"
      default:
        Sentry.captureEvent({
          message: `Unknown permission: ${permission}`,
          extra: {
            permission,
          },
        })
        return permission
    }
  }

  export const empty: T = {
    id: "",
    userId: "",
    clinicId: "",
    canRegisterPatients: false,
    canViewHistory: false,
    canEditRecords: false,
    canDeleteRecords: false,
    isClinicAdmin: false,
    canEditOtherProviderEvent: false,
    canDownloadPatientReports: false,
    canPrescribeMedications: false,
    canDispenseMedications: false,
    canDeletePatientVisits: false,
    canDeletePatientRecords: false,
    createdBy: Option.none(),
    lastModifiedBy: Option.none(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  /** Default permissions for a new user (most restrictive) */
  export const defaultPermissions: Omit<
    T,
    "id" | "userId" | "clinicId" | "createdAt" | "updatedAt"
  > = {
    canRegisterPatients: false,
    canViewHistory: false,
    canEditRecords: false,
    canDeleteRecords: false,
    isClinicAdmin: false,
    canEditOtherProviderEvent: false,
    canDownloadPatientReports: false,
    canPrescribeMedications: false,
    canDispenseMedications: false,
    canDeletePatientVisits: false,
    canDeletePatientRecords: false,
    createdBy: Option.none(),
    lastModifiedBy: Option.none(),
  }

  /** Admin permissions (all permissions granted) */
  export const adminPermissions: Omit<T, "id" | "userId" | "clinicId" | "createdAt" | "updatedAt"> =
    {
      canRegisterPatients: true,
      canViewHistory: true,
      canEditRecords: true,
      canDeleteRecords: true,
      isClinicAdmin: true,
      canEditOtherProviderEvent: true,
      canDownloadPatientReports: true,
      canPrescribeMedications: true,
      canDispenseMedications: true,
      canDeletePatientVisits: true,
      canDeletePatientRecords: true,
      createdBy: Option.none(),
      lastModifiedBy: Option.none(),
    }

  /** Provider permissions (typical medical provider) */
  export const providerPermissions: Omit<
    T,
    "id" | "userId" | "clinicId" | "createdAt" | "updatedAt"
  > = {
    canRegisterPatients: true,
    canViewHistory: true,
    canEditRecords: true,
    canDeleteRecords: false,
    isClinicAdmin: false,
    canEditOtherProviderEvent: false,
    canDownloadPatientReports: false,
    canPrescribeMedications: false,
    canDispenseMedications: false,
    canDeletePatientVisits: false,
    canDeletePatientRecords: false,
    createdBy: Option.none(),
    lastModifiedBy: Option.none(),
  }

  /** Viewer permissions (read-only access) */
  export const viewerPermissions: Omit<
    T,
    "id" | "userId" | "clinicId" | "createdAt" | "updatedAt"
  > = {
    canRegisterPatients: false,
    canViewHistory: true,
    canEditRecords: false,
    canDeleteRecords: false,
    isClinicAdmin: false,
    canEditOtherProviderEvent: false,
    canDownloadPatientReports: false,
    canPrescribeMedications: false,
    canDispenseMedications: false,
    canDeletePatientVisits: false,
    canDeletePatientRecords: false,
    createdBy: Option.none(),
    lastModifiedBy: Option.none(),
  }

  export const hasAnyPermission = (permissions: T): boolean => {
    return (
      permissions.canRegisterPatients ||
      permissions.canViewHistory ||
      permissions.canEditRecords ||
      permissions.canDeleteRecords ||
      permissions.isClinicAdmin ||
      permissions.canEditOtherProviderEvent ||
      permissions.canDownloadPatientReports ||
      permissions.canPrescribeMedications ||
      permissions.canDispenseMedications ||
      permissions.canDeletePatientVisits ||
      permissions.canDeletePatientRecords
    )
  }

  export const isPermissionPresent = (permissions: T, permission: UserPermissionsT): boolean => {
    // Admin has all permissions
    if (permissions.isClinicAdmin) return true
    return permissions[permission]
  }

  export const getPermissionsList = (permissions: T): string[] => {
    const list: string[] = []
    if (permissions.isClinicAdmin) {
      list.push("Clinic Administrator")
    }
    if (permissions.canRegisterPatients) {
      list.push("Register Patients")
    }
    if (permissions.canViewHistory) {
      list.push("View Patient History")
    }
    if (permissions.canEditRecords) {
      list.push("Edit Records")
    }
    if (permissions.canDeleteRecords) {
      list.push("Delete Records")
    }
    if (permissions.canEditOtherProviderEvent) {
      list.push("Edit Other Provider Events")
    }
    if (permissions.canDownloadPatientReports) {
      list.push("Download Patient Reports")
    }
    if (permissions.canPrescribeMedications) {
      list.push("Prescribe Medications")
    }
    if (permissions.canDispenseMedications) {
      list.push("Dispense Medications")
    }
    if (permissions.canDeletePatientVisits) {
      list.push("Delete Patient Visits")
    }
    if (permissions.canDeletePatientRecords) {
      list.push("Delete Patient Records")
    }
    return list
  }

  export namespace Check {
    /** Minimal user context needed for permission checking (extracted from providerStore) */
    export type PermissionContext = {
      readonly userId: string
      readonly role: string | null
      readonly clinicId: string | null
      readonly isPermissionsDisabled: boolean
    }

    /** Permission requirement with single/all/any semantics */
    export type PermissionCheck =
      | { kind: "single"; permission: UserPermissionsT }
      | { kind: "all"; permissions: ReadonlyArray<UserPermissionsT> }
      | { kind: "any"; permissions: ReadonlyArray<UserPermissionsT> }

    type PermissionDeniedError = Extract<DataError, { _tag: "PermissionDenied" }>

    /** Require a single permission */
    export const requirePermission = (p: UserPermissionsT): PermissionCheck => ({
      kind: "single",
      permission: p,
    })

    /** Require all listed permissions */
    export const requireAll = (ps: ReadonlyArray<UserPermissionsT>): PermissionCheck => ({
      kind: "all",
      permissions: ps,
    })

    /** Require at least one of the listed permissions */
    export const requireAny = (ps: ReadonlyArray<UserPermissionsT>): PermissionCheck => ({
      kind: "any",
      permissions: ps,
    })

    function denied(permission: string): Result<never, PermissionDeniedError> {
      return err({
        _tag: "PermissionDenied",
        permission,
        message: `You do not have the required permission: ${permission}`,
      })
    }

    function describeCheck(check: PermissionCheck): string {
      switch (check.kind) {
        case "single":
          return check.permission
        case "all":
          return check.permissions.join(" AND ")
        case "any":
          return check.permissions.join(" OR ")
      }
    }

    /**
     * Pure permission check. No DB calls, no side effects.
     *
     * Decision cascade:
     * 1. If global permissions are disabled -> allow
     * 2. If user role is "super_admin" -> allow
     * 3. If permissions object is null -> deny
     * 4. Check the specific permission(s) via isPermissionPresent
     */
    export const checkPermission = (
      ctx: PermissionContext,
      check: PermissionCheck,
      permissions: UserClinicPermissions.T | null,
    ): Result<true, PermissionDeniedError> => {
      Logger.log({ msg: "✅ : ", isPermissionDisabled: ctx.isPermissionsDisabled, role: ctx.role })
      if (ctx.isPermissionsDisabled) return ok(true)
      if (ctx.role === "super_admin") return ok(true)

      if (permissions === null) {
        return err({
          _tag: "PermissionDenied",
          permission: describeCheck(check),
          message: "No permissions found for user at this clinic.",
        })
      }

      switch (check.kind) {
        case "single":
          return isPermissionPresent(permissions, check.permission)
            ? ok(true)
            : denied(check.permission)

        case "all":
          for (const p of check.permissions) {
            if (!isPermissionPresent(permissions, p)) {
              return denied(p)
            }
          }
          return ok(true)

        case "any": {
          const hasAny = check.permissions.some((p) => isPermissionPresent(permissions, p))
          return hasAny ? ok(true) : denied(check.permissions.join(", "))
        }
      }
    }

    /**
     * Check if a user can edit a record another provider may have authored.
     *
     * Requires `basePermission` always, plus canEditOtherProviderEvent when the
     * record belongs to someone else. An unknown author (empty id) counts as
     * someone else — the stricter reading is the safe one when the record does
     * not say who wrote it.
     */
    export const checkEditOwnedRecordPermission = (
      ctx: PermissionContext,
      permissions: UserClinicPermissions.T | null,
      basePermission: UserPermissionsT,
      recordCreatedByUserId: string,
    ): Result<true, PermissionDeniedError> => {
      const baseCheck = checkPermission(ctx, requirePermission(basePermission), permissions)
      if (!baseCheck.ok) return baseCheck

      if (recordCreatedByUserId !== ctx.userId) {
        return checkPermission(ctx, requirePermission("canEditOtherProviderEvent"), permissions)
      }

      return ok(true)
    }

    export const checkEditEventPermission = (
      ctx: PermissionContext,
      permissions: UserClinicPermissions.T | null,
      eventCreatedByUserId: string,
    ): Result<true, PermissionDeniedError> =>
      checkEditOwnedRecordPermission(ctx, permissions, "canEditRecords", eventCreatedByUserId)

    /**
     * Check if a user can edit an existing prescription.
     *
     * Prescribing is the base capability rather than canEditRecords: changing a
     * prescription is writing one. canEditOtherProviderEvent still applies on
     * top for another provider's prescription, which is what that flag documents.
     */
    export const checkEditPrescriptionPermission = (
      ctx: PermissionContext,
      permissions: UserClinicPermissions.T | null,
      prescriptionCreatedByUserId: string,
    ): Result<true, PermissionDeniedError> =>
      checkEditOwnedRecordPermission(
        ctx,
        permissions,
        "canPrescribeMedications",
        prescriptionCreatedByUserId,
      )

    /** The permission each named operation requires. */
    export const OPERATION_PERMISSIONS = {
      "patient:register": requirePermission("canRegisterPatients"),
      "patient:edit": requirePermission("canEditRecords"),
      "patient:delete": requirePermission("canDeletePatientRecords"),
      "patient:downloadReport": requirePermission("canDownloadPatientReports"),

      "visit:create": requirePermission("canEditRecords"),
      "visit:delete": requirePermission("canDeletePatientVisits"),

      "event:create": requirePermission("canEditRecords"),
      "event:edit": requirePermission("canEditRecords"),
      "event:delete": requirePermission("canDeleteRecords"),

      "prescription:create": requirePermission("canPrescribeMedications"),
      // Ownership-agnostic, so it answers "could this user edit any prescription
      // here?" — right for showing an Edit affordance. The save path uses
      // checkEditPrescriptionPermission, which also weighs who wrote it.
      "prescription:edit": requirePermission("canPrescribeMedications"),
      "prescription:updateStatus": requirePermission("canPrescribeMedications"),
      "prescription:dispense": requirePermission("canDispenseMedications"),

      "vitals:create": requirePermission("canEditRecords"),
      "vitals:edit": requirePermission("canEditRecords"),

      "diagnosis:create": requirePermission("canEditRecords"),
      "diagnosis:edit": requirePermission("canEditRecords"),

      "appointment:create": requirePermission("canEditRecords"),
      "appointment:update": requirePermission("canEditRecords"),
      "appointment:markComplete": requirePermission("canEditRecords"),
    } as const

    export type OperationName = keyof typeof OPERATION_PERMISSIONS
  }

  export namespace DB {
    export type T = UserClinicPermissionModel
    /**
     * @deprecated Hits the database per call; prefer the pure `Check` helpers.
     */
    export const userHasPermission = async (
      userId: string,
      clinicId: string,
      permission: UserPermissionsT,
    ): Promise<Either.Either<boolean, string>> => {
      const user = providerStore.getSnapshot().context
      const userRole = Option.getOrNull(user.role)
      // Super admins bypass every permission.
      if (userRole === "super_admin") {
        return Either.right(true)
      }

      const hasPermission = await database
        .get<UserClinicPermissionModel>("user_clinic_permissions")
        .query(
          Q.where("user_id", userId),
          Q.where("clinic_id", clinicId),
          Q.where(getSQLPermissionName(permission), true),
          Q.take(1),
        )
        .fetch()

      const emptyPermissions = hasPermission.length === 0
      const permissionStatus = hasPermission[0]?.[permission]

      if (emptyPermissions || permissionStatus === false) {
        return Either.left("User does not have permission")
      } else {
        return Either.right(true)
      }
    }

    export const getForUserAndClinic = async (
      userId: string,
      clinicId: string,
    ): Promise<Option.Option<UserClinicPermissions.T>> => {
      const permissions = await database
        .get<UserClinicPermissionModel>("user_clinic_permissions")
        .query(Q.where("user_id", userId), Q.where("clinic_id", clinicId), Q.take(1))
        .fetch()

      if (permissions.length === 0) {
        return Option.none()
      }

      return Option.some(fromDB(permissions[0]))
    }

    export const getClinicIdsWithPermission = async (
      userId: string,
      permission: UserPermissionsT,
    ): Promise<string[]> => {
      const user = providerStore.getSnapshot().context
      const userRole = Option.getOrNull(user.role)

      // Set in the admin server: disables permission checking across every
      // clinic for as long as the user is signed in.
      const isPermissionDisabled =
        (await AppConfig.DB.getValue(
          AppConfig.Namespaces.AUTH,
          "disable-mobile-permissions-checking",
          Option.getOrNull(user.clinic_id),
        )) || false

      if (userRole === "super_admin" || isPermissionDisabled) {
        return database
          .get<ClinicModel>("clinics")
          .query()
          .fetch()
          .then((clinics) => {
            return clinics.map((clinic) => clinic.id)
          })
      }

      const clinics = await database
        .get<UserClinicPermissionModel>("user_clinic_permissions")
        .query(Q.where("user_id", userId), Q.where(camelToSnake(permission), true))
        .fetch()

      return clinics.map((clinic) => clinic.clinicId)
    }

    export const getAllForUser = async (userId: string): Promise<UserClinicPermissions.T[]> => {
      const permissions = await database
        .get<UserClinicPermissionModel>("user_clinic_permissions")
        .query(Q.where("user_id", userId))
        .fetch()

      return permissions.map(fromDB)
    }

    export const getAllForClinic = async (clinicId: string): Promise<UserClinicPermissions.T[]> => {
      const permissions = await database
        .get<UserClinicPermissionModel>("user_clinic_permissions")
        .query(Q.where("clinic_id", clinicId))
        .fetch()

      return permissions.map(fromDB)
    }

    export function subscribe(
      userId: string,
      clinicId: string,
      callback: (permissions: Option.Option<UserClinicPermissions.T>, isLoading: boolean) => void,
    ): { unsubscribe: () => void } {
      let isLoading = true

      const subscription = database
        .get<UserClinicPermissionModel>("user_clinic_permissions")
        .query(Q.where("user_id", userId), Q.where("clinic_id", clinicId), Q.take(1))
        .observe()
        .subscribe((dbPermissions) => {
          const permissions =
            dbPermissions.length > 0 ? Option.some(fromDB(dbPermissions[0])) : Option.none()
          isLoading = false
          callback(permissions, isLoading)
        })

      return {
        unsubscribe: () => subscription.unsubscribe(),
      }
    }

    export const fromDB = (dbPermissions: DB.T): UserClinicPermissions.T => ({
      id: dbPermissions.id,
      userId: dbPermissions.user.id,
      clinicId: dbPermissions.clinic.id,
      canRegisterPatients: dbPermissions.canRegisterPatients,
      canViewHistory: dbPermissions.canViewHistory,
      canEditRecords: dbPermissions.canEditRecords,
      canDeleteRecords: dbPermissions.canDeleteRecords,
      isClinicAdmin: dbPermissions.isClinicAdmin,
      canEditOtherProviderEvent: dbPermissions.canEditOtherProviderEvent,
      canDownloadPatientReports: dbPermissions.canDownloadPatientReports,
      canPrescribeMedications: dbPermissions.canPrescribeMedications,
      canDispenseMedications: dbPermissions.canDispenseMedications,
      canDeletePatientVisits: dbPermissions.canDeletePatientVisits,
      canDeletePatientRecords: dbPermissions.canDeletePatientRecords,
      createdBy: Option.fromNullable(dbPermissions.createdBy),
      lastModifiedBy: Option.fromNullable(dbPermissions.lastModifiedBy),
      createdAt: dbPermissions.createdAt,
      updatedAt: dbPermissions.updatedAt,
    })
  }
}

export default UserClinicPermissions
