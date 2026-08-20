/**
 * The app navigator (formerly "AppNavigator" and "MainNavigator") is used for the primary
 * navigation flows of your app.
 * Generally speaking, it will contain an auth flow (registration, login, forgot password)
 * and a "main" flow which the user will use once logged in.
 */
import { ComponentProps, useCallback, useEffect } from "react"
import * as SecureStore from "expo-secure-store"
import { createDrawerNavigator } from "@react-navigation/drawer"
import { NavigationContainer, NavigationState } from "@react-navigation/native"
import { createNativeStackNavigator, NativeStackScreenProps } from "@react-navigation/native-stack"
import * as Sentry from "@sentry/react-native"
import { useSelector } from "@xstate/react"

import { AppDrawer } from "@/components/AppDrawer"
import Config from "@/config"
import Peer from "@/models/Peer"
import User from "@/models/User"
import { ErrorBoundary } from "@/screens/ErrorScreen/ErrorBoundary"
import { LoginScreen } from "@/screens/LoginScreen"
import { PrivacyPolicyScreen } from "@/screens/PrivacyPolicyScreen"
import { SettingsScreen } from "@/screens/SettingsScreen"
import { ManualSyncScreen } from "@/screens/ManualSyncScreen"
import { SyncSettingsScreen } from "@/screens/SyncSettingsScreen"
import { startSync } from "@/services/syncService"
import { languageStore } from "@/store/language"
import { providerStore } from "@/store/provider"
import { useAppTheme } from "@/theme/context"

import { AppointmentNavigator } from "./AppointmentNavigator"
import { PharmacyNavigator } from "./PharmacyNavigator"
import { getActiveRouteName, navigationRef, useBackButtonHandler } from "./navigationUtilities"
import { PatientNavigator } from "./PatientNavigator"
import { shouldSeedE2E } from "@/utils/e2e"
import {
  applyScreenCapturePolicy,
  initScreenCaptureProtection,
  setScreenCaptureAllowance,
} from "@/utils/screenCapture"
import { useAppConfigValue } from "@/hooks/useAppConfigValue"
import AppConfig from "@/models/AppConfig"
import { Logger } from "@hikmahealth/js-utils"

/**
 * This type allows TypeScript to know what routes are defined in this navigator
 * as well as what properties (if any) they might take when navigating to them.
 *
 * For more information, see this documentation:
 *   https://reactnavigation.org/docs/params/
 *   https://reactnavigation.org/docs/typescript#type-checking-the-navigator
 *   https://reactnavigation.org/docs/typescript/#organizing-types
 */
export type AppStackParamList = {
  Welcome: undefined
  Login: undefined
  PrivacyPolicy: undefined
  Settings: undefined
  Patients: undefined
  Appointment: undefined
  NewVisit: undefined
  EventForm: undefined
  PatientVisitsList: undefined
  FormEventsList: undefined
  VisitEventsList: { patientId: string; visitId: string; visitTimestamp?: number }
  PatientRegistrationForm: { editPatientId?: string }
  SyncSettings: undefined
  ManualSync: { peerId: string; sinceDays: number | null }
  VitalHistory: undefined
  VitalForm: undefined
  AppointmentEditorForm: undefined
  AppointmentView: undefined
  PharmacyView: undefined
  PatientPrescriptionsList: undefined
  PrescriptionEditorForm: undefined
  VisitPrescriptions: undefined
  PrescriptionView: undefined
  DispensePrescriptionItem: undefined
  // IGNITE_GENERATOR_ANCHOR_APP_STACK_PARAM_LIST
}

/**
 * This is a list of all the route names that will exit the app if the back button
 * is pressed while in that screen. Only affects Android.
 */
const exitRoutes = Config.exitRoutes

export type AppStackScreenProps<T extends keyof AppStackParamList> = NativeStackScreenProps<
  AppStackParamList,
  T
>

// Documentation: https://reactnavigation.org/docs/stack-navigator/
const Stack = createNativeStackNavigator<AppStackParamList>()

const Drawer = createDrawerNavigator()

const AuthStack = () => {
  const {
    theme: { colors },
  } = useAppTheme()

  return (
    <Stack.Navigator
      initialRouteName="Login"
      screenOptions={{
        headerShown: false,
        navigationBarColor: colors.background,
        contentStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
    </Stack.Navigator>
  )
}

const MainDrawer = () => {
  const {
    theme: { colors },
  } = useAppTheme()
  const { isRTL } = useSelector(languageStore, (state) => state.context)
  const drawerPosition = isRTL ? "right" : "left"

  return (
    <Drawer.Navigator
      drawerContent={(props) => <AppDrawer {...props} />}
      screenOptions={{
        headerShown: false,
        drawerStyle: {
          backgroundColor: colors.background,
        },
        drawerPosition,
      }}
    >
      <Drawer.Screen name="Patients" component={PatientNavigator} />
      <Drawer.Screen name="Settings" component={SettingsScreen} />
      <Drawer.Screen
        name="SyncSettings"
        options={{ title: "Sync Settings", headerShown: true }}
        component={SyncSettingsScreen}
      />
      {/* Blocking: no header and no drawer swipe, so the screen's own controls
          are the only way out of a run. */}
      <Drawer.Screen
        name="ManualSync"
        options={{ headerShown: false, swipeEnabled: false }}
        component={ManualSyncScreen}
      />
      <Drawer.Screen name="PrivacyPolicy" component={PrivacyPolicyScreen} />
      <Drawer.Screen name="Appointment" component={AppointmentNavigator} />
      <Drawer.Screen name="Pharmacy" component={PharmacyNavigator} />
    </Drawer.Navigator>
  )
}

const AppStack = () => {
  const { setThemeContextOverride } = useAppTheme()

  useEffect(() => {
    setThemeContextOverride("light")
  }, [])

  const provider = useSelector(providerStore, (state) => state.context)

  const isSignedIn = useSelector(providerStore, (state) => {
    const { id, name, email } = state.context
    return !!id && !!name && !!email
  })

  Logger.warn({ isSignedIn, provider })

  useEffect(() => {
    if (!isSignedIn) return
    // Seeded e2e runs are hermetic and offline — never auto-sync.
    if (shouldSeedE2E) return

    const run = async () => {
      // Re-pairing only happens on the login screen, so a device with no server
      // is stuck until it goes back there.
      if (await Peer.hasNoConfiguredServer()) {
        // Production logger: the only path that ends a session unasked, and
        // support has nothing else to go on. No PHI, credentials or tokens.
        Logger.Production.warn("[Login] No sync server configured — signing out")
        await User.signOut()
        return
      }

      // Determine which peer type is active — cloud re-auth only applies to cloud peers
      const cloudPeers = await Peer.DB.getActiveByType("cloud_server")
      const hasCloudPeer = cloudPeers.length > 0

      const reachableCloudServer = hasCloudPeer ? await Peer.isAnyCloudReachable() : null
      if (reachableCloudServer?.reachable && reachableCloudServer.url) {
        const email = await SecureStore.getItemAsync("provider_email")
        const password = await SecureStore.getItemAsync("provider_password")

        if (email && password) {
          try {
            // The cloud peer this block just proved reachable — the active
            // peer on a hub-paired device is the hub, which has no /api routes.
            await User.signIn(email, password, reachableCloudServer.url)
          } catch (err) {
            Logger.error("[Login] Error logging in with email and password")
            Sentry.captureException(err, {
              level: "warning",
              extra: {
                message:
                  "Failed sign in on re-authentication. App store has user, but failed to re-authenticate them",
              },
            })
          }
        }
      }

      // Sync with whichever peer is active (cloud or hub) — peerSync handles dispatch.
      // Automatic: this fires on login with nobody waiting on it, so it should
      // give up rather than queue behind a manual sync that covers the same ground.
      await startSync(provider.email, { trigger: "auto" })
    }

    run().catch((err) => {
      Logger.error({ msg: "[Login] Failed to start sync:", err })
      Sentry.captureException(err, {
        level: "error",
        extra: { message: "Failed to start sync" },
      })
    })
  }, [isSignedIn, provider.email])

  return isSignedIn ? <MainDrawer /> : <AuthStack />
}

export interface NavigationProps extends Partial<
  ComponentProps<typeof NavigationContainer<AppStackParamList>>
> {}

export const AppNavigator = (props: NavigationProps) => {
  const { navigationTheme } = useAppTheme()
  // Pulled out of the spread rather than overridden after it: screen capture
  // protection hangs off these two, and a spread that drifted below the
  // overrides would disable it on every screen with nothing to catch it.
  const { onReady, onStateChange, ...containerProps } = props

  useBackButtonHandler((routeName) => exitRoutes.includes(routeName))

  useEffect(() => {
    void initScreenCaptureProtection()
  }, [])

  // No clinic: read above the point one is selected, and the setting is
  // organization-wide, so a clinic-scoped row deliberately does not apply.
  const { value: screenCaptureAllowance } = useAppConfigValue(
    AppConfig.Namespaces.SYSTEM,
    "allow-mobile-screen-capture",
    null,
  )

  useEffect(() => {
    void setScreenCaptureAllowance(
      screenCaptureAllowance === true || screenCaptureAllowance === "true",
    )
  }, [screenCaptureAllowance])

  // `onStateChange` does not fire on the first render, and persisted navigation
  // restores the app into the last-visited screen — usually a patient record —
  // so the initial route has to be covered here or it renders unprotected.
  const handleReady = useCallback(() => {
    void applyScreenCapturePolicy(
      navigationRef.isReady() ? getActiveRouteName(navigationRef.getRootState()) : undefined,
    )
    onReady?.()
  }, [onReady])

  const handleStateChange = useCallback(
    (state: NavigationState | undefined) => {
      void applyScreenCapturePolicy(state ? getActiveRouteName(state) : undefined)
      onStateChange?.(state)
    },
    [onStateChange],
  )

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navigationTheme}
      onReady={handleReady}
      onStateChange={handleStateChange}
      {...containerProps}
    >
      <ErrorBoundary catchErrors={Config.catchErrors}>
        <AppStack />
      </ErrorBoundary>
    </NavigationContainer>
  )
}
