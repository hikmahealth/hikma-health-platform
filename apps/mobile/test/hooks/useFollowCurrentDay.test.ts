/**
 * The agenda screens stay mounted for the life of the app, so a device carried
 * overnight kept filtering on yesterday — which reads as "the prescription I
 * just wrote is missing".
 */

import { act, renderHook } from "@testing-library/react-native"
import { startOfDay } from "date-fns"

import { useFollowCurrentDay } from "@/hooks/useFollowCurrentDay"

const LAST_NIGHT = new Date(2019, 2, 14, 23, 40)
const AFTER_MIDNIGHT = new Date(2019, 2, 15, 0, 3)
const A_PINNED_DAY = startOfDay(new Date(2019, 2, 11))

const ONE_MINUTE_MS = 60_000

/** Moves the clock first, then lets the hook's interval observe it. */
const passTime = (to: Date) => {
  act(() => {
    jest.setSystemTime(to)
    jest.advanceTimersByTime(ONE_MINUTE_MS)
  })
}

describe("useFollowCurrentDay", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(LAST_NIGHT)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("moves a selection that is tracking today onto the new day", () => {
    const onDayChange = jest.fn()
    renderHook(() => useFollowCurrentDay(startOfDay(LAST_NIGHT), onDayChange))

    passTime(AFTER_MIDNIGHT)

    expect(onDayChange).toHaveBeenCalledTimes(1)
    expect(onDayChange).toHaveBeenCalledWith(startOfDay(AFTER_MIDNIGHT))
  })

  it("leaves a day the user pinned alone", () => {
    const onDayChange = jest.fn()
    renderHook(() => useFollowCurrentDay(A_PINNED_DAY, onDayChange))

    passTime(AFTER_MIDNIGHT)

    expect(onDayChange).not.toHaveBeenCalled()
  })

  it("says nothing while the day has not turned over", () => {
    const onDayChange = jest.fn()
    renderHook(() => useFollowCurrentDay(startOfDay(LAST_NIGHT), onDayChange))

    passTime(new Date(2019, 2, 14, 23, 55))

    expect(onDayChange).not.toHaveBeenCalled()
  })

  it("reports each turnover once, not on every check", () => {
    const onDayChange = jest.fn()
    const { rerender } = renderHook(
      ({ selected }: { selected: Date }) => useFollowCurrentDay(selected, onDayChange),
      { initialProps: { selected: startOfDay(LAST_NIGHT) } },
    )

    passTime(AFTER_MIDNIGHT)
    rerender({ selected: startOfDay(AFTER_MIDNIGHT) })
    passTime(new Date(2019, 2, 15, 8, 0))

    expect(onDayChange).toHaveBeenCalledTimes(1)
  })

  it("keeps following across further days once it has rolled over", () => {
    const onDayChange = jest.fn()
    const { rerender } = renderHook(
      ({ selected }: { selected: Date }) => useFollowCurrentDay(selected, onDayChange),
      { initialProps: { selected: startOfDay(LAST_NIGHT) } },
    )

    passTime(AFTER_MIDNIGHT)
    rerender({ selected: startOfDay(AFTER_MIDNIGHT) })
    passTime(new Date(2019, 2, 16, 0, 5))

    expect(onDayChange).toHaveBeenCalledTimes(2)
    expect(onDayChange).toHaveBeenLastCalledWith(startOfDay(new Date(2019, 2, 16)))
  })

  it("stops checking once the screen is gone", () => {
    const onDayChange = jest.fn()
    const { unmount } = renderHook(() => useFollowCurrentDay(startOfDay(LAST_NIGHT), onDayChange))

    unmount()
    passTime(AFTER_MIDNIGHT)

    expect(onDayChange).not.toHaveBeenCalled()
  })
})
