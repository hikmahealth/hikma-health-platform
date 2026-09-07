import { EventEmitter } from "expo"

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

/**
 * To contain a list of events to be communicated in other parts of the application
 */
type InAppEvents = {
  /**
   * Emitted when a patient is created
   */
  "patient.created": (id: string, data: Record<string, string>) => void
}
