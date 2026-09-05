import { useEffect, useState } from "react"
import { Logger } from "@hikmahealth/js-utils"
import { Q } from "@nozbe/watermelondb"

import database from "../db"
import ClinicModel from "../db/model/Clinic"
import { observerWithFallback } from "../db/observerWithFallback"

/**
 * The unarchived clinics, kept live.
 *
 * `observeWithColumns` rather than `observe`: a rename or a move to another city
 * is an in-place edit that leaves query membership untouched, and callers render
 * `name` and filter on `country`/`city`.
 */
export const useDBClinicsList = () => {
  const [clinics, setClinics] = useState<Array<ClinicModel>>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const sub = database
      .get<ClinicModel>("clinics")
      .query(Q.where("is_archived", false))
      .observeWithColumns(["name", "country", "city"])
      .subscribe(
        observerWithFallback(
          (rows: ClinicModel[]) => {
            setClinics(rows)
            setIsLoading(false)
          },
          (error) => {
            Logger.error(error)
            setClinics([])
            setIsLoading(false)
          },
        ),
      )

    return () => sub.unsubscribe()
  }, [])

  return { clinics, isLoading }
}
