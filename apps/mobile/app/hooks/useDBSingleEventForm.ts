import { useEffect, useState } from "react"
import { catchError, of as of$ } from "@nozbe/watermelondb/utils/rx"
import { Logger } from "@hikmahealth/js-utils"

import database from "../db"
import EventFormModel from "../db/model/EventForm"

export function useDBSingleEventForm(formId: string): EventFormModel | null {
  const [form, setForm] = useState<EventFormModel | null>(null)

  useEffect(() => {
    const sub = database
      .get<EventFormModel>("event_forms")
      .findAndObserve(formId)
      .pipe(
        // Absent on this device — deleted upstream or never synced; unpiped it crashes the app.
        catchError((error) => {
          Logger.error(error)
          return of$(null)
        }),
      )
      .subscribe((form) => {
        setForm(form)
      })
    return () => {
      return sub?.unsubscribe()
    }
  }, [formId])

  return form
}
