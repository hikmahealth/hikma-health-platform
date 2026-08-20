/**
 * `empty` held its timestamps in a module constant, so they froze at import.
 * A session spanning midnight stamped every new prescription with the previous
 * day until a cold start.
 */

import { addDays, differenceInCalendarDays } from "date-fns"

import Prescription from "@/models/Prescription"

const LAST_NIGHT = new Date(2026, 7, 20, 23, 40)
const THIS_MORNING = new Date(2026, 7, 21, 9, 15)

describe("Prescription.empty", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("reads the clock at each call rather than at import", () => {
    jest.useFakeTimers()

    jest.setSystemTime(LAST_NIGHT)
    const openedLastNight = Prescription.empty()

    jest.setSystemTime(THIS_MORNING)
    const openedThisMorning = Prescription.empty()

    expect(openedLastNight.prescribedAt).toEqual(LAST_NIGHT)
    expect(openedThisMorning.prescribedAt).toEqual(THIS_MORNING)
  })

  it("does not carry a prescribing day across midnight", () => {
    jest.useFakeTimers()

    jest.setSystemTime(LAST_NIGHT)
    Prescription.empty()

    jest.setSystemTime(THIS_MORNING)
    expect(differenceInCalendarDays(Prescription.empty().prescribedAt, THIS_MORNING)).toBe(0)
  })

  it("returns a fresh object so callers cannot share one another's edits", () => {
    const first = Prescription.empty()
    const second = Prescription.empty()

    first.items.push({} as never)

    expect(second.items).toEqual([])
    expect(second).not.toBe(first)
  })

  it("expires relative to the moment it was drafted, never in the past", () => {
    jest.useFakeTimers()
    jest.setSystemTime(THIS_MORNING)

    const draft = Prescription.empty()

    expect(draft.expirationDate.getTime()).toBeGreaterThan(draft.prescribedAt.getTime())
    expect(draft.expirationDate).toEqual(Prescription.defaultExpirationDate(THIS_MORNING))
  })
})

describe("Prescription.defaultExpirationDate", () => {
  it("is ninety days after the prescribing moment", () => {
    expect(Prescription.defaultExpirationDate(THIS_MORNING)).toEqual(addDays(THIS_MORNING, 90))
  })

  it("keeps the time of day, so the window is exact rather than rounded", () => {
    const expiry = Prescription.defaultExpirationDate(LAST_NIGHT)

    expect(expiry.getHours()).toBe(LAST_NIGHT.getHours())
    expect(expiry.getMinutes()).toBe(LAST_NIGHT.getMinutes())
  })
})
