import { FC, useCallback, useEffect, useRef } from "react"
import { ActivityIndicator, AppState, BackHandler, ViewStyle } from "react-native"

import { useKeepAwake } from "expo-keep-awake"

import { Button } from "@/components/Button"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { View } from "@/components/View"
import { useManualSync } from "@/hooks/useManualSync"
import type { AppStackScreenProps } from "@/navigators/AppNavigator"
import { appStateStore } from "@/store/appState"
import { colors } from "@/theme/colors"

/** Well inside appState's five-minute LOCK_TIMEOUT. */
const ACTIVITY_HEARTBEAT_MS = 60_000

const HEADINGS: Record<string, string> = {
  pushing: "Uploading your changes…",
  pulling: "Downloading records…",
  done: "Sync complete",
  error: "Sync stopped",
}

/**
 * Full-screen, non-dismissable progress for a manual sync.
 *
 * The blocking presentation is deliberate: a run can last ten minutes, and a
 * record edited mid-run would be overwritten by a later page. Removing the
 * opportunity is simpler and safer than resolving the conflict afterwards.
 *
 * Note this only prevents UI-driven writes. `syncLock` remains the actual
 * mutual-exclusion mechanism — do not treat this screen as a substitute for it.
 */
export const ManualSyncScreen: FC<AppStackScreenProps<"ManualSync">> = ({ route, navigation }) => {
  const { peerId, sinceDays } = route.params
  const { state, start, resume, abort } = useManualSync(peerId)
  const runStartedForThisVisit = useRef(false)

  // A ten-minute foreground operation must not let the device sleep: JS timers
  // throttle and the transfer stalls in a way that looks like a hang.
  useKeepAwake()

  const isRunning = state.phase === "pushing" || state.phase === "pulling"

  const beginVisit = useCallback(() => {
    if (runStartedForThisVisit.current) return
    runStartedForThisVisit.current = true
    start(sinceDays)
  }, [start, sinceDays])

  useEffect(() => {
    beginVisit()
  }, [beginVisit])

  // Drawer screens are not unmounted on navigate-away, so a mount-only guard
  // would leave this showing the previous run's "Sync complete" — with nothing
  // started — for every visit after the first. The flag is cleared on blur so
  // each arrival begins a run, and the focus that follows mount is a no-op
  // because the mount effect has already claimed it.
  useEffect(() => {
    const unsubscribeFocus = navigation.addListener("focus", beginVisit)
    const unsubscribeBlur = navigation.addListener("blur", () => {
      runStartedForThisVisit.current = false
    })
    return () => {
      unsubscribeFocus()
      unsubscribeBlur()
    }
  }, [navigation, beginVisit])

  // Hardware back must not dismiss a run mid-write.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => isRunning)
    return () => subscription.remove()
  }, [isRunning])

  // The idle lock fires after five minutes without interaction. An unattended
  // backfill would trip it: the run itself survives, but locking mid-transfer
  // with no visible progress is what makes users force-quit.
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => {
      appStateStore.trigger.SET_LAST_ACTIVE_TIME({ lastActiveTime: new Date() })
    }, ACTIVITY_HEARTBEAT_MS)
    return () => clearInterval(timer)
  }, [isRunning])

  // Backgrounded, the heartbeat above is throttled with everything else, so
  // returning to the foreground can be minutes past the lock timeout with the
  // run still healthy. Refreshing on the way back keeps the lock from firing on
  // an operation the user never actually left unattended.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active" && isRunning) {
        appStateStore.trigger.SET_LAST_ACTIVE_TIME({ lastActiveTime: new Date() })
      }
    })
    return () => subscription.remove()
  }, [isRunning])

  return (
    <Screen style={$root} preset="fixed" safeAreaEdges={["top", "bottom"]}>
      <View style={$centre} direction="column" gap={16}>
        {isRunning && <ActivityIndicator size="large" color={colors.palette.primary600} />}

        <Text size="lg" text={HEADINGS[state.phase] ?? "Preparing…"} />

        {state.phase === "pulling" && (
          <Text
            size="xs"
            text={`${state.table} · ${state.recordsApplied} records · page ${state.pagesApplied}`}
          />
        )}

        {state.phase === "pushing" && state.recordsPushed > 0 && (
          <Text size="xs" text={`${state.recordsPushed} records uploaded`} />
        )}

        {state.phase === "done" && (
          <View direction="column" gap={4}>
            <Text
              size="sm"
              text={`${state.recordsPushed} uploaded, ${state.recordsApplied} downloaded`}
            />
            {state.rejectedCount > 0 && (
              <Text
                size="sm"
                style={$warning}
                text={`${state.rejectedCount} records could not be saved to the server and are still pending`}
              />
            )}
          </View>
        )}

        {state.phase === "error" && <Text size="sm" text={state.error ?? "Unknown error"} />}

        {isRunning && <Button text="Cancel" onPress={abort} />}

        {state.phase === "error" && state.resumable && <Button text="Continue" onPress={resume} />}

        {!isRunning && <Button text="Close" onPress={() => navigation.goBack()} />}
      </View>
    </Screen>
  )
}

const $root: ViewStyle = { flex: 1, paddingHorizontal: 24, paddingTop: 24 }
const $centre: ViewStyle = { flex: 1, justifyContent: "center", alignItems: "center" }
const $warning = { color: colors.palette.angry500 }
