import { Button } from "@/components/Button"
import { Text } from "@/components/Text"
import { View } from "@/components/View"
import database from "@/db"
import PatientRiskProfile from "@/db/model/PatientRiskProfile"
import { getSharedEventEmitter, useSharedEventEmitter } from "@/next/core/events/app"
import AppState from "@/next/core/store"
import { colors } from "@/theme/colors"
import { Q } from "@nozbe/watermelondb"
import {
  createAtom,
  createAtomConfig,
  createStoreHook,
  useAtom,
  useAtomState,
  useSelector,
} from "@xstate/store-react"
import { pre } from "effect/FastCheck"
import { upperFirst } from "es-toolkit/compat"
import { useEventListener } from "expo"
import { HeartPulse, Wind } from "lucide-react-native"
import { useEffect, useState } from "react"
import { useImmer } from "use-immer"

type RiskPrediction = { type: string; score: string }

export function HERSRiskProfile({ patientId }: { patientId: string }) {
  const isHersEnabled = useSelector(AppState, (s) => s.context.is_hers_enabled)

  const [predictions, set] = useImmer<{
    loading: boolean
    queued?: boolean
    data: RiskPrediction[]
    error?: null | Error
  }>({ loading: false, data: [] })

  const ee = useSharedEventEmitter()

  // useEventListener(getSharedEventEmitter(), "prediction.trigger", (id) => {
  //   if (id !== patientId) {
  //     return
  //   }

  //   console.log("this is the patient prediction", id)
  // })

  // Attaches an event listener to listen to changes that involve
  // getting patient predictions
  useEventListener(getSharedEventEmitter(), `prediction.status.patient`, (id, state) => {
    if (id !== patientId) {
      return
    }

    console.log(id, state)

    switch (state.status) {
      case "processing": {
        return set((d) => {
          d.loading = true
          d.queued = false
        })
      }
      case "completed": {
        return set((d) => {
          d.loading = false
          d.queued = false
          d.data = state.data
        })
      }
      case "error": {
        return set((d) => {
          d.loading = false
          d.queued = false
          d.data = []
          d.error = state.err as Error
        })
      }
      case "queued": {
        // TRIGGER SYNC here...
        // should enable syncing
        return set((d) => {
          d.loading = false
          d.data = []
          d.queued = true
        })
      }
    }
  })

  useEffect(() => {
    if (!isHersEnabled) {
      return
    }

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

  if (!isHersEnabled) {
    return null
  }

  if (predictions.data.length === 0) {
    if (predictions.loading) {
      return (
        <View gap={6} mb={4}>
          <Text>Processing...</Text>
        </View>
      )
    }

    return (
      <View gap={6} mb={4}>
        <Button
          onPress={() => {
            if (!ee.current) {
              console.log("THIS IS NULL and shouldn't be the case")
              return
            }
            ee.current?.emit("prediction.trigger", patientId)
          }}
        >
          Make Prediction
        </Button>
      </View>
    )
  }

  return (
    <View gap={6} mb={4}>
      <Text preset="formLabel" text="Environmental Risk Profile" />
      <View gap={6}>
        {predictions.data.map((prediction) => {
          const isHigh = prediction.score === "high"
          const isMedium = prediction.score === "medium" || prediction.score === "moderate"
          const scoreColor = isHigh ? colors.error : isMedium ? "#f59e0b" : "#16a34a"
          const bgColor = isHigh ? colors.errorBackground : isMedium ? "#fef3c7" : "#dcfce7"
          const Icon = prediction.type === "cvd" ? HeartPulse : Wind
          const typeLabel = upperFirst(prediction.type)

          return (
            <View
              key={prediction.type}
              direction="row"
              alignItems="center"
              gap={8}
              style={{
                borderRadius: 8,
                borderColor: scoreColor,
                borderWidth: 1,
                backgroundColor: bgColor,
                padding: 8,
              }}
            >
              <Icon size={16} color={scoreColor} />
              <View flex={1}>
                <Text text={typeLabel} size="xs" />
                <Text
                  text={`Risk: ${upperFirst(prediction.score)}`}
                  size="xxs"
                  style={{ color: scoreColor }}
                />
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}
