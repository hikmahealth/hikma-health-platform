/* eslint-disable import/first */
/**
 * Welcome to the main entry point of the app. In this file, we'll
 * be kicking off our app.
 *
 * Most of this file is boilerplate and you shouldn't need to modify
 * it very often. But take some time to look through and understand
 * what is going on here.
 *
 * The app navigation resides in ./app/navigators, so head over there
 * if you're interested in adding screens and navigators.
 */
if (__DEV__) {
  // Load Reactotron in development only.
  // Note that you must be using metro's `inlineRequires` for this to work.
  // If you turn it off in metro.config.js, you'll have to manually import it.
  require("./devtools/ReactotronConfig.ts")
}
import "react-native-get-random-values"
import "./utils/gestureHandler"

import "@/db"
import { useEffect, useState } from "react"
import { useFonts } from "expo-font"
import * as Linking from "expo-linking"
import * as SecureStorage from "expo-secure-store"
import { Option } from "effect"
import { KeyboardProvider } from "react-native-keyboard-controller"
import { RootSiblingParent } from "react-native-root-siblings"
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context"

import { initI18n } from "./i18n"
import UserClinicPermissions from "./models/UserClinicPermissions"
import { AppNavigator } from "./navigators/AppNavigator"
import { useNavigationPersistence } from "./navigators/navigationUtilities"
import Peer from "./models/Peer"
import { APP_STATE_STORAGE_KEY, hydrateAppState } from "./store/appState"
import { languageStore } from "./store/language"
import { providerStore } from "./store/provider"
import { QueryProvider } from "./providers/QueryProvider"
import { DataAccessProvider } from "./providers/DataAccessProvider"
import { useOperationModeInit } from "./hooks/useOperationModeInit"
import { ThemeProvider, useAppTheme } from "./theme/context"
import { customFontsToLoad } from "./theme/typography"
// import { loadDateFnsLocale } from "./utils/formatDate"
import { shouldSeedE2E } from "./utils/e2e"
import { seedE2EDatabase } from "./db/seedE2E"
import { Logger } from "@hikmahealth/js-utils"
import { Text, View } from "react-native"
import * as storage from "../_next/app/core/kv"
import AppState, {
  INITIAL_APP_STATE,
  APP_STATE_STORAGE_KEY as NEW_APP_STORAGE_KEY,
} from "../_next/app/core/store"
import * as SplashScreen from "expo-splash-screen"

import { createAtom, useAtom, useAtomState, useSelector } from "@xstate/store-react"
import { LIGHT_THEME } from "../_next/app/core/theme"
import { UserStore } from "../_next/app/store-user"
import { loadDateFnsLocale } from "../_next/app/utils/date"
import Language from "../_next/app/core/language"

export const NAVIGATION_PERSISTENCE_KEY = "NAVIGATION_STATE"

// Web linking configuration
const prefix = Linking.createURL("/")
const config = {
  screens: {
    Login: {
      path: "",
    },
    Welcome: "welcome",
    Demo: {
      screens: {
        DemoShowroom: {
          path: "showroom/:queryIndex?/:itemIndex?",
        },
        DemoDebug: "debug",
        DemoPodcastList: "podcast",
        DemoCommunity: "community",
      },
    },
  },
}

/**
 * Atom for when the
 */
const readyAtom = createAtom(false)

// // subscription is related to the splash screen.
// // after hiding splash screen. it may be removed
// const sub = readyAtom.subscribe((ready) => {
//   if (ready) {
//     console.log("splash screen hidden")
//     SplashScreen.hide()
//     sub.unsubscribe()
//   }
// })

/**
 * Contains the main render logic
 */
export function App() {
  const { initialNavigationState, onNavigationStateChange } = useNavigationPersistence(
    storage,
    NAVIGATION_PERSISTENCE_KEY,
  )

  return (
    <QueryProvider>
      <DataAccessProvider>
        <RootSiblingParent>
          <SafeAreaProvider>
            <KeyboardProvider>
              <ThemeProvider>
                <AppNavigator
                  linking={{
                    prefixes: [prefix],
                    config,
                  }}
                  initialState={initialNavigationState}
                  onStateChange={onNavigationStateChange}
                />
              </ThemeProvider>
            </KeyboardProvider>
          </SafeAreaProvider>
        </RootSiblingParent>
      </DataAccessProvider>
    </QueryProvider>
  )
}

/**
 * Application container to load the states needed to initialize the application properly
 * this include language, navigation state, themes .. .e.t.c
 * @returns
 */
export default function AppContainer() {
  const ready = useAtom(readyAtom)

  const [areFontsLoaded, fontLoadError] = useFonts(customFontsToLoad)

  /**
   * Handler that pulls data from storage
   */
  useEffect(() => {
    if (ready) {
      return
    }

    if (!areFontsLoaded) {
      return
    }

    ;(async () => {
      // load the
      await seedE2EDatabase()

      // pull data from old app state
      const state = await SecureStorage.getItemAsync(APP_STATE_STORAGE_KEY)
      if (state) {
        // use this as reference for new storage
        const stored = JSON.parse(state)
        AppState.trigger.write({
          notifications_enabled: stored.notificationsEnabled,
          lock_when_idle: stored.lockWhenIdle ?? false,
          is_hers_enabled: stored.hersEnabled ?? false,
          theme: LIGHT_THEME,
          language: INITIAL_APP_STATE["language"],
        })
      } else {
        // pull data from new storage
        const value = await SecureStorage.getItemAsync(NEW_APP_STORAGE_KEY)
        if (value) {
          // write the stored state to context
          AppState.trigger.writeFromString(value)
        }
      }

      // load the language related stuff
      const locale = AppState.getSnapshot().context.language.locale
      await initI18n(locale ?? Language.LOCALE_MAP["en-US"])
      loadDateFnsLocale(locale)

      // load the provider information
      // NOTE: using the old code... later should attempt to replace with on in `_next/app/store-user.ts`
      try {
        const storedProvider = await SecureStorage.getItemAsync("providerStore")
        const email = await SecureStorage.getItemAsync("provider_email")
        const password = await SecureStorage.getItemAsync("provider_password")

        Logger.warn({ msg: "First one 🚩🚩🚩: ", data: { storedProvider, email, password } })

        // Fallback to old storage method for backward compatibility
        let credentials = { email: "", password: "" }
        const storedCredentials = await SecureStorage.getItemAsync("providerCredentials")
        if (storedCredentials) {
          credentials = JSON.parse(storedCredentials)
        }

        const finalEmail = email || credentials.email
        const finalPassword = password || credentials.password

        if (storedProvider && finalEmail && finalPassword) {
          const payload = JSON.parse(storedProvider)
          providerStore.send({
            type: "set_provider",
            id: payload.id,
            name: payload.name,
            email: payload.email,
            role: Option.fromNullable(payload.role),
            instance_url: Option.fromNullable(payload.instance_url),
            clinic_id: Option.fromNullable(payload.clinic_id),
            clinic_name: Option.fromNullable(payload.clinic_name),
            permissions: Option.none<UserClinicPermissions.T>(),
          })

          console.log("check payload:", payload)
          if (payload.id) {
            // this is the new implementation,
            // being used beside the old one
            UserStore.trigger.write({
              id: payload.id,
              name: payload.name,
              email: payload.email,
              role: payload.role,
              clinic_id: payload.clinic_id,
              clinic_name: payload.clinic_name,
              permissions: {}, // Record<string, boolean>
            })

            // delete the old state
            await SecureStorage.deleteItemAsync(APP_STATE_STORAGE_KEY)
          }
        } else {
          providerStore.send({ type: "reset" })
          // will use default UserStore if not written
        }
      } catch (error) {
        Logger.error({ msg: "Failed to load provider store:", error })
        providerStore.send({ type: "reset" })
      }
      // after all is done, set as ready
      readyAtom.set(true)
    })()
  }, [areFontsLoaded])

  if (!ready) {
    Logger.log("application not ready. loading dependencies")
    return
  }

  return <App />
}

// /**
//  * This is the root component of our app.
//  * @param {AppProps} props - The props for the `App` component.
//  * @returns {JSX.Element} The rendered `App` component.
//  */
// export function _App() {
//   const language = useSelector(languageStore, (state) => state.context.language)

//   const [areFontsLoaded, fontLoadError] = useFonts(customFontsToLoad)
//   const [isI18nInitialized, setIsI18nInitialized] = useState(false)
//   const [isProviderStoreInitialized, setIsProviderStoreInitialized] = useState(false)

//   useOperationModeInit()

//   useEffect(() => {
//     hydrateAppState()
//     // Migrate legacy SecureStore API URL → Peer table (one-time, safe to call repeatedly)
//     Peer.migrateFromLegacyApiUrl().catch((d) => Logger.error(d))
//   }, [])

//   useEffect(() => {
//     initI18n(Option.some(language || "en-US"))
//       .then(() => setIsI18nInitialized(true))
//       .then(() => loadDateFnsLocale())
//   }, [])

//   useEffect(() => {
//     // Restore the provider store from SecureStore on cold start.
//     // Cloud re-authentication is handled later by AppNavigator (gated by peer type),
//     // so this effect only needs to hydrate the store from cached data.
//     const loadProviderStore = async () => {
//       try {
//         const storedProvider = await SecureStorage.getItemAsync("providerStore")
//         const email = await SecureStorage.getItemAsync("provider_email")
//         const password = await SecureStorage.getItemAsync("provider_password")

//         Logger.warn({ msg: "First one 🚩🚩🚩: ", data: { storedProvider, email, password } })

//         // Fallback to old storage method for backward compatibility
//         let credentials = { email: "", password: "" }
//         const storedCredentials = await SecureStorage.getItemAsync("providerCredentials")
//         if (storedCredentials) {
//           credentials = JSON.parse(storedCredentials)
//         }

//         const finalEmail = email || credentials.email
//         const finalPassword = password || credentials.password

//         if (storedProvider && finalEmail && finalPassword) {
//           const payload = JSON.parse(storedProvider)
//           providerStore.send({
//             type: "set_provider",
//             id: payload.id,
//             name: payload.name,
//             email: payload.email,
//             role: Option.fromNullable(payload.role),
//             instance_url: Option.fromNullable(payload.instance_url),
//             clinic_id: Option.fromNullable(payload.clinic_id),
//             clinic_name: Option.fromNullable(payload.clinic_name),
//             permissions: Option.none<UserClinicPermissions.T>(),
//           })
//         } else {
//           providerStore.send({ type: "reset" })
//         }
//       } catch (error) {
//         Logger.error({ msg: "Failed to load provider store:", error })
//         providerStore.send({ type: "reset" })
//       }
//     }

//     const boot = async () => {
//       // Seed before hydrating so the injected session lands in SecureStore
//       // ahead of loadProviderStore reading it.
//       if (shouldSeedE2E) {
//         await seedE2EDatabase()
//       }
//       await loadProviderStore()
//     }

//     boot().finally(() => setIsProviderStoreInitialized(true))
//   }, [])

// console.log({
//   isProviderStoreInitialized,
//   isNavigationStateRestored,
//   isI18nInitialized,
//   fontLoadError,
//   areFontsLoaded,
// })

// // Before we show the app, we have to wait for our state to be ready.
// // In the meantime, don't render anything. This will be the background
// // color set in native by rootView's background color.
// // In iOS: application:didFinishLaunchingWithOptions:
// // In Android: https://stackoverflow.com/a/45838109/204044
// // You can replace with your own loading component if you wish.
// if (
//   !isNavigationStateRestored ||
//   !isI18nInitialized ||
//   (!areFontsLoaded && !fontLoadError)
//   // || !isProviderStoreInitiarlized
// ) {
//   console.log("YOU SHOULDN'T SEE THIS")
//   return null
// }

// otherwise, we're ready to render the app
//   return (
//     <QueryProvider>
//       <DataAccessProvider>
//         <RootSiblingParent>
//           <SafeAreaProvider initialMetrics={initialWindowMetrics}>
//             <KeyboardProvider>
//               <ThemeProvider>
//                 <AppNavigator
//                   linking={linking}
//                   initialState={initialNavigationState}
//                   onStateChange={onNavigationStateChange}
//                 />
//               </ThemeProvider>
//             </KeyboardProvider>
//           </SafeAreaProvider>
//         </RootSiblingParent>
//       </DataAccessProvider>
//     </QueryProvider>
//   )
// }
