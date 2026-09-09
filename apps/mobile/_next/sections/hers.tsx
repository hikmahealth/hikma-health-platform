import { Text } from "@/components/Text"
import { View } from "@/components/View"
import database from "@/db"
import PatientRiskProfile from "@/db/model/PatientRiskProfile"
import { getSharedEventEmitter, useSharedEventEmitter } from "@/next/core/events/app"
import AppState from "@/next/core/store"
import { colors } from "@/theme/colors"
import { Q } from "@nozbe/watermelondb"
import { useSelector } from "@xstate/store-react"
import { upperFirst } from "es-toolkit/compat"
import { useEventListener } from "expo"
import { Asterisk, HeartPulse, Wind } from "lucide-react-native"
import { useEffect } from "react"
import { Pressable } from "react-native"
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated"
import { useImmer } from "use-immer"

type RiskPrediction = { type: string; score: string }

function SpinningAsterisk({
  spinning,
  size = 16,
  color,
}: {
  spinning: boolean
  size?: number
  color?: string
}) {
  const rotation = useSharedValue(0)

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }))

  useEffect(() => {
    if (spinning) {
      rotation.value = withRepeat(withTiming(360, { duration: 900 }), -1, false)
    } else {
      cancelAnimation(rotation)
      rotation.value = withTiming(0, { duration: 300 })
    }
  }, [spinning, rotation])

  return (
    <Animated.View style={animatedStyle}>
      <Asterisk size={size} color={color ?? colors.palette.primary500} />
    </Animated.View>
  )
}

function RiskChip({ prediction }: { prediction: RiskPrediction }) {
  const isHigh = prediction.score === "high"
  const isMedium = prediction.score === "medium" || prediction.score === "moderate"
  const scoreColor = isHigh ? colors.error : isMedium ? "#f59e0b" : "#16a34a"
  const bgColor = isHigh ? colors.errorBackground : isMedium ? "#fef3c7" : "#dcfce7"
  const Icon = prediction.type === "cvd" ? HeartPulse : Wind

  return (
    <View
      direction="row"
      alignItems="center"
      gap={4}
      style={{
        borderRadius: 20,
        borderColor: scoreColor,
        borderWidth: 1,
        backgroundColor: bgColor,
        paddingVertical: 3,
        paddingHorizontal: 8,
      }}
    >
      <Icon size={11} color={scoreColor} />
      <Text size="xxs" style={{ color: scoreColor }}>
        {`${upperFirst(prediction.type)} · ${upperFirst(prediction.score)}`}
      </Text>
    </View>
  )
}

export function HERSRiskProfile({ patientId }: { patientId: string }) {
  const isHersEnabled = useSelector(AppState, (s) => s.context.is_hers_enabled)

  const [predictions, set] = useImmer<{
    loading: boolean
    queued?: boolean
    data: RiskPrediction[]
    error?: null | Error
  }>({ loading: false, data: [] })

  const ee = useSharedEventEmitter()

  // Attaches an event listener to listen to changes that involve
  // getting patient predictions
  useEventListener(getSharedEventEmitter(), `prediction.status.patient`, (id, state) => {
    if (id !== patientId) return

    switch (state.status) {
      case "processing":
        return set((d) => {
          d.loading = true
          d.queued = false
        })
      case "completed":
        return set((d) => {
          d.loading = false
          d.queued = false
          d.data = state.data
        })
      case "error":
        return set((d) => {
          d.loading = false
          d.queued = false
          d.data = []
          d.error = state.err as Error
        })
      case "queued":
        // TRIGGER SYNC here...
        // should enable syncing
        return set((d) => {
          d.loading = false
          d.data = []
          d.queued = true
        })
    }
  })

  useEffect(() => {
    if (!isHersEnabled) return

    set((d) => {
      d.loading = true
    })

    const sub = database
      .get<PatientRiskProfile>("patient_risk_profiles")
      .query(
        Q.where("patient_id", patientId),
        Q.where("kind", "risk_prediction"),
        Q.where("is_deleted", false),
      )
      .observe()
      .subscribe((records) => {
        // Parse each record, keeping updatedAt for recency comparison
        const parsed = records
          .map((r) => {
            try {
              const value = JSON.parse(r.jsonValue ?? "") as RiskPrediction
              return { value, updatedAt: r.updatedAt }
            } catch {
              return null
            }
          })
          .filter((r): r is { value: RiskPrediction; updatedAt: Date } => r !== null)

        // Group by type, keep only the most recent entry per type
        const byType = new Map<string, { value: RiskPrediction; updatedAt: Date }>()
        for (const item of parsed) {
          const existing = byType.get(item.value.type)
          if (!existing || item.updatedAt > existing.updatedAt) {
            byType.set(item.value.type, item)
          }
        }

        set((s) => {
          s.loading = false
          s.data = [...byType.values()].map((item) => item.value)
        })
      })

    return () => sub.unsubscribe()
  }, [patientId, isHersEnabled])

  if (!isHersEnabled) return null

  // No predictions yet — show a touchable prompt to compute them
  if (predictions.data.length === 0) {
    return (
      <Pressable
        android_ripple={{ color: colors.palette.primary100 }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: colors.palette.primary200,
          backgroundColor: colors.palette.primary50,
        }}
        onPress={() => {
          if (predictions.loading) return
          if (!ee.current) {
            console.log("THIS IS NULL and shouldn't be the case")
            return
          }
          ee.current.emit("prediction.trigger", patientId)
        }}
      >
        <Text size="xs" color={colors.palette.primary600} text="Compute Risk Prediction" />
        <SpinningAsterisk
          spinning={predictions.loading}
          size={14}
          color={colors.palette.primary500}
        />
      </Pressable>
    )
  }

  // Predictions loaded — show chips with a re-compute button
  return (
    <View direction="row" alignItems="center" gap={8}>
      <View flex={1} direction="row" flexWrap="wrap" gap={6}>
        {predictions.data.map((prediction) => (
          <RiskChip key={prediction.type} prediction={prediction} />
        ))}
      </View>
      <Pressable
        android_ripple={{ color: colors.palette.primary100, borderless: true, radius: 18 }}
        onPress={() => {
          if (!ee.current) return
          ee.current.emit("prediction.trigger", patientId)
        }}
        style={{ padding: 4 }}
      >
        <SpinningAsterisk
          spinning={predictions.loading}
          size={18}
          color={colors.palette.primary400}
        />
      </Pressable>
    </View>
  )
}
