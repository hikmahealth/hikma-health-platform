import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import { isSameDay, startOfDay } from "date-fns"

/**
 * How long a foregrounded agenda can sit on the previous day. Returning from
 * the background re-reads immediately.
 */
const DAY_CHECK_INTERVAL_MS = 60_000

/**
 * Calls `onDayChange` when the calendar day turns over, so an agenda left
 * mounted overnight stops filtering on yesterday.
 *
 * A date the user picked is left alone: the selection follows the clock only
 * while it still equals the day last observed.
 */
export function useFollowCurrentDay(selectedDate: Date, onDayChange: (today: Date) => void): void {
  const lastKnownDay = useRef(startOfDay(new Date()))
  const selected = useRef(selectedDate)
  const notify = useRef(onDayChange)

  selected.current = selectedDate
  notify.current = onDayChange

  useEffect(() => {
    const syncToCurrentDay = () => {
      const today = startOfDay(new Date())
      if (isSameDay(today, lastKnownDay.current)) return

      const wasFollowingToday = isSameDay(selected.current, lastKnownDay.current)
      lastKnownDay.current = today

      if (wasFollowingToday) notify.current(today)
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") syncToCurrentDay()
    })
    const timer = setInterval(syncToCurrentDay, DAY_CHECK_INTERVAL_MS)

    return () => {
      subscription.remove()
      clearInterval(timer)
    }
  }, [])
}
