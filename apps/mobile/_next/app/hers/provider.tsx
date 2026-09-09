import { useDataAccess } from "@/providers/DataAccessProvider"
import { useEffect } from "react"
import { useSelector } from "@xstate/store-react"
import AppState from "../core/store"
import { Logger } from "@hikmahealth/js-utils"
import { HikmaHealthEventEmitter, useSharedEventEmitter } from "../core/events/app"
import { localeDate } from "@/utils/date"

import { uuidv7 } from "uuidv7"
import { subDays } from "date-fns"
import { appStateStore } from "@/store/appState"
import PeerState from "../peers/state"
import { useSync } from "@/hooks/useSync"

const hersURL = process.env.EXPO_PUBLIC_HERS_API_URL

// TODO: create a state so as to exclusively manage HERS states
function useHERSEventsSusbcriptions(ee: HikmaHealthEventEmitter | null) {
  const { provider } = useDataAccess()
  const serverUrl = useSelector(PeerState, (s) => {
    if (s.context.status !== "linked") {
      return null
    }

    if (s.context.type !== "cloud_server") {
      return null
    }

    return s.context.url
  })

  /**
   * HERS related subscription fired when a patient is registered
   */
  useEffect(() => {
    if (!ee || !serverUrl) {
      return
    }

    const evt = ee.addListener("prediction.trigger", (id) => {
      console.log("details:", id)
      provider.patients
        .getById(id)
        .then(async (res) => {
          if (!res.ok || !res.data) {
            return
          }

          let age_in_days = 0
          try {
            const d = new Date(localeDate(res.data.dateOfBirth, "yyyy-MM-dd"))
            age_in_days = d.getFullYear()
          } catch (err) {
            Logger.warn("failed to parse the dateOfBirth. Using the age=0 as default")
          }

          ee.emit("hers.patient_risk_prediction", [
            { id, sex: res.data.sex as "male" | "female", age_in_days },
          ])
        })
        .catch((err) => {
          Logger.error({ msg: "failed to get patient data", data: err.message })
        })
    })

    return evt.remove
  }, [ee, serverUrl])

  /**
   * HERS related subscription fired when a patient is registered
   */
  useEffect(() => {
    if (!ee || !serverUrl) {
      return
    }

    const evt = ee.addListener("hers.patient_risk_prediction", (patients) => {
      console.log("running the prediction...")
      const q = new URLSearchParams()

      q.set("request_id", uuidv7())
      q.set("on_complete", `${serverUrl}/api/hers/output/prediction`)
      const BIN_WINDOW_DAYS = 30 // this should also reflect the shape of the features in the data
      const end_date = new Date()
      const start_date = subDays(end_date, BIN_WINDOW_DAYS)
      q.set("start_date", start_date.toISOString())
      q.set("end_date", end_date.toISOString())
      q.set("data_bins", BIN_WINDOW_DAYS.toString())

      const url = `${hersURL}/v1/api/compute/risk/async?=${q.toString()}`
      console.log("running the prediction here: ", hersURL)
      console.log("full url: ", url)

      for (let p of patients) {
        ee.emit("prediction.status.patient", p.id, { status: "processing" })
      }

      fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa(`${process.env.EXPO_PUBLIC_HERS_SERVICE_CLIENT_ID}:${process.env.EXPO_PUBLIC_HERS_SERVICE_CLIENT_SECRET}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patients),
      })
        .then(() => {
          for (let p of patients) {
            ee.emit("prediction.status.patient", p.id, { status: "queued" })
          }
        })
        .catch((err) => {
          for (let p of patients) {
            ee.emit("prediction.status.patient", p.id, { status: "error", err: err })
          }
        })
    })

    return evt.remove
  }, [ee, serverUrl])

  return null
}

export function useHERS() {
  const ee = useSharedEventEmitter()
  const is_hers_enabled = useSelector(AppState, (s) => s.context.is_hers_enabled)

  const activeEe = ee.current && is_hers_enabled ? ee.current : null

  useEffect(() => {
    if (!activeEe) {
      Logger.info("either HERS isn't enabled / the event emitter isn't initialized")
    }
  }, [activeEe])

  return useHERSEventsSusbcriptions(activeEe)
}
