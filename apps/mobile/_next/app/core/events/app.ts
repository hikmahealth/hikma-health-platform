import { EventEmitter } from "expo"
import { useEffect, useRef } from "react"

export type HikmaHealthEventEmitter = InstanceType<EventEmitter<InAppEvents>>

class AppEventBus extends EventEmitter<InAppEvents> {
  private static _instance: AppEventBus | null = null
  private constructor() {
    super()
  }

  /**
   * Singleton model
   */
  static initialize(): AppEventBus {
    if (AppEventBus._instance !== null) {
      // instance exists
      return AppEventBus._instance
    }

    console.log("INSTANCE!!!!")
    const instance = new AppEventBus()
    AppEventBus._instance = instance
    return instance
  }
}

/**
 * Provider a single instance if the event emitter
 */
export function getSharedEventEmitter() {
  return AppEventBus.initialize()
}

export function useSharedEventEmitter() {
  const ref = useRef<ReturnType<typeof getSharedEventEmitter>>(null)

  useEffect(() => {
    if (ref.current) {
      return
    }

    ref.current = getSharedEventEmitter()
  }, [])

  return ref
}

/**
 * To contain a list of events to be communicated in other parts of the application
 */
type InAppEvents = {
  /**
   * Emitted when a patient is created
   */
  "prediction.trigger": (id: string) => void

  /**
   * Used in computing the patient risk score
   */
  "hers.patient_risk_prediction": (
    patients: Array<{ id: string; age_in_days: number | string; sex: "male" | "female" }>,
  ) => void

  /**
   * Publish the results of making the prediction
   * @param id
   * @param status
   * @returns
   */
  "prediction.status.patient": (
    id: string,
    state:
      | { status: "processing" }
      | { status: "queued" } // for when there's asyncronous processing
      | { status: "error"; err: unknown }
      | { status: "completed"; data: any },
  ) => void
}
