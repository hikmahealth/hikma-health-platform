import * as SecureStorage from "expo-secure-store"
import { createStore } from "@xstate/store"
import * as Sentry from "@sentry/react-native"
import { Option } from "effect"

import User from "@/models/User"
import UserClinicPermissions from "@/models/UserClinicPermissions"
import { Logger } from "@hikmahealth/js-utils"
import { z } from "zod"

export const NEW_PROVIDER_STORAGE_KEY = "providerStore.v2"

const providerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  role: z.string().nullable(),
  clinic_id: z.string().nullable(),
  clinic_name: z.string().nullable(),

  // this permissions set should be resolved differently
  permissions: z.record(z.string(), z.boolean().default(false)),
})

export const UserStore = createStore({
  schemas: {
    context: z.object({
      locked: z.boolean().default(false),
      data: providerSchema.nullable().default(null),
    }),
  },
  context: {
    locked: false,
    data: null,
  },
  on: {
    persist(context, _, enqueue) {
      enqueue.effect(() => {
        SecureStorage.setItemAsync(NEW_PROVIDER_STORAGE_KEY, JSON.stringify(context)).catch(
          (error) => {
            Logger.error({ msg: "[Provider] Failed to persist the session", error })
            Sentry.captureException(error)
          },
        )
      })

      return context
    },
    reset(_context, _, enqueue) {
      enqueue.effect(UserStore.trigger.persist)
      return { locked: false, data: null }
    },

    write(_, data: z.input<typeof providerSchema>) {
      Logger.log({ msg: "write operation: ", data: JSON.stringify(data, null, 2) })
      return { locked: false, data: providerSchema.parse(data) }
    },
  },
})
