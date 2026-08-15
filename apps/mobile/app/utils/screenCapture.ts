import { Platform } from "react-native"
import * as ScreenCapture from "expo-screen-capture"
import * as Sentry from "@sentry/react-native"
import { Logger } from "@hikmahealth/js-utils"

import type { AppStackParamList } from "@/navigators/AppNavigator"

import { isE2E } from "./e2e"

/**
 * Routes on which the user may screenshot, record, or cast.
 *
 * These carry no patient data, and remote support needs to screen-share the
 * sync screens to troubleshoot a clinic's setup. Every other route — including
 * `Login` and `Welcome`, which show server and clinic configuration — is
 * protected, so a newly added screen is covered without being listed anywhere.
 */
const CAPTURE_EXEMPT_ROUTES: ReadonlySet<keyof AppStackParamList> = new Set([
  "Settings",
  "SyncSettings",
  "ManualSync",
  "PrivacyPolicy",
])

/**
 * Gated on `__DEV__` as a build-time guard, matching `shouldSeedE2E` in
 * `./e2e`: `isE2E` is an ordinary launch argument, so without `__DEV__` a
 * release build could be started with screen capture protection turned off.
 */
const isProtectionDisabled: boolean = __DEV__ && isE2E

/**
 * Whether screen capture is permitted on a route.
 *
 * An unrecognised name is treated as protected, so the failure mode of a typo
 * or a renamed route is a screen that cannot be captured rather than one that
 * leaks.
 */
export function isCaptureExempt(routeName: string): boolean {
  return CAPTURE_EXEMPT_ROUTES.has(routeName as keyof AppStackParamList)
}

/**
 * Namespaces this module's hold on screen capture.
 *
 * `expo-screen-capture` ref-counts by key and keeps protection on while any key
 * is held. Without our own, releasing on a settings route would also release a
 * `usePreventScreenCapture()` held elsewhere, which defaults to `"default"`.
 */
const CAPTURE_KEY = "route-policy"

// The two policy inputs, both starting at their protective value: the route is
// unknown until navigation reports one, and the admin setting arrives with the
// first sync, so a fresh install is protected before either is known.
let focusedRouteName: string | undefined = undefined
let isCaptureAllowedByAdmin = false

/**
 * An admin who has allowed capture overrides the route policy outright — the
 * setting exists to permit screenshots of patient records, which is the case
 * the route list is there to block.
 */
function shouldProtectCapture(): boolean {
  if (isCaptureAllowedByAdmin) return false
  if (focusedRouteName === undefined) return true
  return !isCaptureExempt(focusedRouteName)
}

let supportCheck: Promise<boolean> | null = null

// Resolved once and shared, so `onReady` cannot race the init effect.
function isSupported(): Promise<boolean> {
  if (!supportCheck) {
    supportCheck = isProtectionDisabled
      ? Promise.resolve(false)
      : ScreenCapture.isAvailableAsync().catch(() => false)
  }
  return supportCheck
}

let lastAppliedProtection: boolean | null = null

let lastAppliedSwitcherProtection: boolean | null = null

let hasReportedFailure = false

// A failure clears the applied state so the next navigation retries, which on a
// device that always fails would otherwise be one Sentry event per navigation
// for the whole session. Log every time; report the session's first failure
// only, counting both call sites — one event is enough to diagnose a device.
function reportFailure(message: string, error: unknown): void {
  Logger.error({ msg: message, err: error })

  if (hasReportedFailure) return
  hasReportedFailure = true
  Sentry.captureException(error, { level: "error", extra: { message } })
}

async function applyCaptureProtection(): Promise<void> {
  const shouldProtect = shouldProtectCapture()

  if (shouldProtect === lastAppliedProtection) return
  // Recorded before awaiting so rapid navigation cannot thrash the native
  // bridge; on iOS every toggle reparents the whole view hierarchy.
  lastAppliedProtection = shouldProtect

  if (!(await isSupported())) return

  try {
    if (shouldProtect) {
      await ScreenCapture.preventScreenCaptureAsync(CAPTURE_KEY)
    } else {
      await ScreenCapture.allowScreenCaptureAsync(CAPTURE_KEY)
    }
  } catch (error) {
    lastAppliedProtection = null
    reportFailure(
      `[ScreenCapture] Failed to ${shouldProtect ? "prevent" : "allow"} screen capture`,
      error,
    )
  }
}

/**
 * The iOS privacy blur that hides the app in the switcher, during
 * backgrounding, and through interruptions such as calls. Android gets the
 * same protection from `FLAG_SECURE`, which the capture policy sets.
 *
 * Not route-dependent — backgrounding is not casting — but it does follow the
 * admin setting, because on iOS the blur is what a screenshot of a
 * backgrounded app captures.
 */
async function applyAppSwitcherProtection(): Promise<void> {
  if (Platform.OS !== "ios") return

  const shouldProtect = !isCaptureAllowedByAdmin

  if (shouldProtect === lastAppliedSwitcherProtection) return
  lastAppliedSwitcherProtection = shouldProtect

  if (!(await isSupported())) return

  try {
    if (shouldProtect) {
      await ScreenCapture.enableAppSwitcherProtectionAsync()
    } else {
      await ScreenCapture.disableAppSwitcherProtectionAsync()
    }
  } catch (error) {
    lastAppliedSwitcherProtection = null
    reportFailure(
      `[ScreenCapture] Failed to ${shouldProtect ? "enable" : "disable"} app switcher protection`,
      error,
    )
  }
}

/**
 * Turns on the iOS privacy blur. Call once, on app start; the capture policy
 * itself follows navigation and is applied by `applyScreenCapturePolicy`.
 */
export async function initScreenCaptureProtection(): Promise<void> {
  await applyAppSwitcherProtection()
}

/**
 * Blocks or permits screen capture to match the focused route.
 *
 * Never rejects: a failure is reported and the applied state is cleared so the
 * next navigation retries. Pass `undefined` when the focused route is unknown —
 * that protects.
 */
export async function applyScreenCapturePolicy(routeName: string | undefined): Promise<void> {
  focusedRouteName = routeName
  await applyCaptureProtection()
}

/**
 * Records whether the admin permits screenshots and screen recording, and
 * re-applies both protections at once — the setting has to take effect on the
 * screen the user is already on, not on their next navigation. Never rejects.
 */
export async function setScreenCaptureAllowance(isAllowed: boolean): Promise<void> {
  isCaptureAllowedByAdmin = isAllowed
  await Promise.all([applyCaptureProtection(), applyAppSwitcherProtection()])
}
