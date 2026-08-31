import { useEffect, useState } from "react"
import { Pressable, StyleProp, ViewStyle } from "react-native"
import { LucideRefreshCcw } from "lucide-react-native"
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated"
import * as Sentry from "@sentry/react-native"
import Toast from "react-native-root-toast"

import { useSync } from "@/hooks/useSync"
import { translate } from "@/i18n/translate"
import { colors } from "@/theme/colors"
import { hapticTap } from "@/utils/haptics"
import { useIsMounted } from "@/utils/useIsMounted"
import { Logger } from "@hikmahealth/js-utils"

export interface SyncButtonIndicatorProps {
  /**
   * An optional style override useful for padding & margin.
   */
  style?: StyleProp<ViewStyle>
}

const showToast = (message: string): void => {
  Toast.show(message, {
    position: Toast.positions.BOTTOM,
    containerStyle: { marginBottom: 100 },
    duration: Toast.durations.LONG,
  })
}

/**
 * A sync button indicator that displays a rotating refresh icon when syncing is in progress.
 *
 * Every press answers: the icon spins, or a toast says a sync is already running.
 */
export const SyncButtonIndicator = (props: SyncButtonIndicatorProps) => {
  const { style } = props
  const $styles = [$container, style]
  const { isFetching, isResolving, isPushing, isIdle, startSync, forceReset, isSyncActive } =
    useSync()
  const isMounted = useIsMounted()

  /** True from the tap until the sync it started settles. */
  const [isRunningFromPress, setIsRunningFromPress] = useState(false)

  const rotation = useSharedValue(0)

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ rotate: `${rotation.value}deg` }],
    }
  })

  // A run signs in and resolves its peer before it reports FETCHING, so the store
  // alone leaves the first seconds of a press looking like a dead tap.
  const isSpinning = isRunningFromPress || isFetching || isResolving || isPushing

  useEffect(() => {
    if (isSpinning) {
      rotation.value = withRepeat(
        withTiming(360, { duration: 1000 }),
        -1, // infinite repetitions
        false, // don't reverse
      )
    } else {
      cancelAnimation(rotation)
      rotation.value = withTiming(0, { duration: 300 })
    }
  }, [isSpinning, rotation])

  const handlePress = () => {
    hapticTap()

    // Asked of the service, not of `isIdle`: a run that ends without reporting
    // leaves the store non-idle forever, which made this button a no-op for the
    // rest of the session. `isRunningFromPress` covers the window before the
    // service knows about the run either.
    if (isRunningFromPress || isSyncActive()) {
      // Production logger — the dev one is a no-op in release builds, and this
      // path would otherwise leave no trace on a field device.
      Logger.Production.warn("[Sync] Press ignored — a sync is already running")
      Sentry.addBreadcrumb({
        category: "sync",
        level: "info",
        message: "Sync button pressed while a sync was already running",
      })
      showToast(translate("common:syncAlreadyRunning"))
      return
    }

    // Nothing is running, so a non-idle state is left over from a run that never
    // reported its end. Clear it or the indicator keeps describing that one.
    if (!isIdle) forceReset()

    setIsRunningFromPress(true)
    startSync()
      .catch((error) => {
        // The service toasts the failures it can name; this records the rest.
        Logger.error({ msg: "[Sync] Sync started from the button failed", error })
      })
      .finally(() => {
        if (isMounted()) setIsRunningFromPress(false)
      })
  }

  return (
    <Pressable style={$styles} onPress={handlePress} testID="syncButton">
      <Animated.View style={animatedStyle}>
        <LucideRefreshCcw color={colors.palette.primary500} size={22} />
      </Animated.View>
    </Pressable>
  )
}

const $container: ViewStyle = {
  justifyContent: "center",
}
