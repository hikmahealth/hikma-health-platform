import * as SecureStorage from "expo-secure-store"
import { createStore } from "@xstate/store"
import * as Sentry from "@sentry/react-native"
import { Option } from "effect"

import User from "@/models/User"
import UserClinicPermissions from "@/models/UserClinicPermissions"
import { Logger } from "@hikmahealth/js-utils"
import { UserStore } from "@/next/store-user"

export const PROVIDER_STORAGE_KEY = "providerStore"

/**
 * Persist the session, flattening Options to the plain values `app.tsx` reads
 * on cold start. Call from `enqueue.effect` — @xstate/store v4 never runs
 * `emits` handlers, so a side effect placed there goes silent.
 */
const persistProvider = (payload: User.Provider): void => {
  const toStore = {
    ...payload,
    id: payload.id,
    name: payload.name,
    role: Option.getOrNull(payload.role),
    instance_url: Option.getOrNull(payload.instance_url),
    clinic_id: Option.getOrNull(payload.clinic_id),
    clinic_name: Option.getOrNull(payload.clinic_name),
    // TODO: get the permissions
    permissions:
      payload.permissions &&
      Option.isOption(payload.permissions) &&
      Option.getOrNull(payload.permissions),
  }

  SecureStorage.setItemAsync(PROVIDER_STORAGE_KEY, JSON.stringify(toStore)).catch((error) => {
    // This signs the user out on the next launch, and Logger is a no-op in release.
    Logger.error({ msg: "[Provider] Failed to persist the session", error })
    Sentry.captureException(error)
  })
}

export const providerStore = createStore({
  context: {
    id: "",
    name: "",
    email: "",
    role: Option.none<User.Role>(),
    instance_url: Option.none<string>(),
    clinic_id: Option.none<string>(),
    clinic_name: Option.none<string>(),
    // Permissions
    permissions:
      Option.none<
        Pick<
          UserClinicPermissions.T,
          | "canRegisterPatients"
          | "canViewHistory"
          | "canEditRecords"
          | "canDeleteRecords"
          | "isClinicAdmin"
        >
      >(),
  },
  on: {
    reset: (context, _, enque) => {
      Logger.warn("🔥 Calling Reset")
      const payload = {
        id: "",
        name: "",
        email: "",
        role: Option.none<User.Role>(),
        instance_url: Option.none<string>(),
        clinic_id: Option.none<string>(),
        clinic_name: Option.none<string>(),
        permissions: Option.none<UserClinicPermissions.T>(),
      }
      enque.effect(() => persistProvider(payload))
      return {
        ...payload,
      }
    },

    set_provider: (context, event: User.Provider, enque) => {
      Logger.log({ msg: "Setting provider:", data: JSON.stringify(event, null, 2) })
      enque.effect(() => persistProvider(event))
      return {
        id: event.id,
        name: event.name,
        email: event.email,
        role: event.role,
        instance_url: event.instance_url,
        clinic_id: event.clinic_id,
        clinic_name: event.clinic_name,
        permissions: Option.none<UserClinicPermissions.T>(),
      }
    },
  },
})

// to keep the UserState and providerStore in sync
providerStore.subscribe(({ context }) => {
  if (context.id.trim()) {
    // this should skip the `null` logic
    UserStore.trigger.write({
      id: context.id,
      name: context.name,
      email: context.email,
      role: Option.getOrNull(context.role),
      clinic_id: Option.getOrNull(context.clinic_id),
      clinic_name: Option.getOrNull(context.clinic_name),
      permissions: {}, // Record<string, boolean>
    })
  }
})
