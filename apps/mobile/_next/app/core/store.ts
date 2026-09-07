import { createStore } from "@xstate/store"
import { z } from "zod"
import Language from "./language"
import * as Sentry from "@sentry/react-native"
import * as SecureStore from "expo-secure-store"

import { storage } from "@/utils/storage"
import { Logger } from "@hikmahealth/js-utils"
import { LIGHT_THEME, schema as appThemeSchema } from "./theme"

const appContextSchema = z.object({
  version: z.number().nullish().default(1),
  notifications_enabled: z.boolean().nullish().default(false),
  lock_when_idle: z.boolean().nullish().default(false),
  last_active_time: z.date().or(z.string().transform(Date)).nullish(),
  is_hers_enabled: z.boolean().nullish().default(false),

  /**
   * Application theme schema
   */
  theme: appThemeSchema.optional(),

  /**
   * Langauge related configuration
   */
  language: z.object({
    locale: z.string(),
    is_rtl: z.boolean(),
  }),
})

/**
 * Combines the entire application state. Shouldn't be used to store sensitive information
 */
export const INITIAL_APP_STATE = appContextSchema.parse({
  version: 1,
  theme: LIGHT_THEME,
  language: {
    locale: Language.LOCALE_MAP["en-US"],
    is_rtl: false,
  },
} as z.input<typeof appContextSchema>)

const AppState = createStore({
  schemas: {
    context: appContextSchema,
  },
  context: INITIAL_APP_STATE,
  on: {
    writeFromString(_context, payload: string) {
      AppState.trigger.write(JSON.parse(payload) as z.input<typeof appContextSchema>)
    },
    write(_context, payload: z.input<typeof appContextSchema>) {
      return appContextSchema.parse(payload)
    },

    /**
     * Can be used to partially to the context
     * @param _context
     * @param data
     * @returns
     */
    set(_context, data: Partial<z.output<typeof appContextSchema>>) {
      return { ..._context, ...data }
    },
  },
})

/**
 * The key location for the app state is different from
 * what was used previously
 */
export const APP_STATE_STORAGE_KEY = "appStateStore.v2"

/***
 * Main subscription to write the updated state to
 * storage
 */
AppState.subscribe((snapshot) => {
  // note might cause double writing, since
  if (snapshot.status === "done") {
    SecureStore.setItemAsync(APP_STATE_STORAGE_KEY, JSON.stringify(snapshot.context)).catch(
      (error) => {
        Logger.error({ msg: "[AppState] Failed to persist settings", error })
        Sentry.captureException(error)
      },
    )
  }

  if (snapshot.status === "error") {
    Sentry.captureException(snapshot.error)
  }
})

// TODO: will need to to syphon data from the storage an the previous storage, then
// store it into this state

export default AppState
