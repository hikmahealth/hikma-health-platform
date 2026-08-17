import { useCallback, useEffect, useMemo, useState } from "react"
import { useSelector } from "@xstate/react"
import { Option } from "effect"

import AppConfig from "@/models/AppConfig"
import UserClinicPermissions from "@/models/UserClinicPermissions"
import { providerStore } from "@/store/provider"

import type { Result } from "../../types/data"
import type { DataError } from "../../types/data"

type PermissionContext = UserClinicPermissions.Check.PermissionContext
type PermissionCheck = UserClinicPermissions.Check.PermissionCheck
type OperationName = UserClinicPermissions.Check.OperationName
type PermissionDeniedError = Extract<DataError, { _tag: "PermissionDenied" }>

const Check = UserClinicPermissions.Check

/**
 * Binds the pure `Check` helpers to live app context: the signed-in provider,
 * the clinic's permissions row, and the admin-set toggle that disables checking.
 */
export function usePermissionGuard() {
  // One selector per field: a selector returning an object would allocate on
  // every store emission and defeat the built-in Object.is check.
  const userId = useSelector(providerStore, (state) => state.context.id)
  const role = useSelector(providerStore, (state) => Option.getOrNull(state.context.role))
  const clinicId = useSelector(providerStore, (state) => Option.getOrNull(state.context.clinic_id))

  const [permissions, setPermissions] = useState<UserClinicPermissions.T | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPermissionsDisabled, setIsPermissionsDisabled] = useState(false)

  // Reload the disable toggle whenever the clinic changes — the config row can
  // be scoped to specific clinics.
  useEffect(() => {
    let cancelled = false
    AppConfig.DB.getValue(
      AppConfig.Namespaces.AUTH,
      "disable-mobile-permissions-checking",
      clinicId,
    ).then((value) => {
      if (!cancelled) {
        const disabled = value === true || value === "true"
        setIsPermissionsDisabled(disabled)
      }
    })
    return () => {
      cancelled = true
    }
  }, [clinicId])

  useEffect(() => {
    if (!userId || !clinicId) {
      setPermissions(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    const { unsubscribe } = UserClinicPermissions.DB.subscribe(
      userId,
      clinicId,
      (optPerms, loading) => {
        const perms = Option.getOrNull(optPerms)
        setPermissions(perms)
        setIsLoading(loading)
      },
    )

    return () => {
      unsubscribe()
    }
  }, [userId, clinicId])

  const ctx: PermissionContext = useMemo(
    () => ({
      userId,
      role,
      clinicId,
      isPermissionsDisabled,
    }),
    [userId, role, clinicId, isPermissionsDisabled],
  )

  const check = useCallback(
    (requirement: PermissionCheck): Result<true, PermissionDeniedError> => {
      return Check.checkPermission(ctx, requirement, permissions)
    },
    [ctx, permissions],
  )

  const checkOperation = useCallback(
    (operationName: OperationName): Result<true, PermissionDeniedError> => {
      const requirement = Check.OPERATION_PERMISSIONS[operationName]
      return Check.checkPermission(ctx, requirement, permissions)
    },
    [ctx, permissions],
  )

  const checkEditEvent = useCallback(
    (eventCreatedByUserId: string): Result<true, PermissionDeniedError> => {
      return Check.checkEditEventPermission(ctx, permissions, eventCreatedByUserId)
    },
    [ctx, permissions],
  )

  const checkEditPrescription = useCallback(
    (prescriptionCreatedByUserId: string): Result<true, PermissionDeniedError> => {
      return Check.checkEditPrescriptionPermission(
        ctx,
        permissions,
        prescriptionCreatedByUserId,
      )
    },
    [ctx, permissions],
  )

  const can = useCallback(
    (operationName: OperationName): boolean => {
      if (isLoading) {
        return false
      }
      return checkOperation(operationName).ok
    },
    [isLoading, checkOperation],
  )

  return {
    permissions,
    isLoading,
    check,
    checkOperation,
    checkEditEvent,
    checkEditPrescription,
    can,
  } as const
}
