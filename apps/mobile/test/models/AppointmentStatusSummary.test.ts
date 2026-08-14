import fc from "fast-check"

import Appointment from "../../app/models/Appointment"

describe("Appointment.summarizeStatuses", () => {
  it("returns an all-zero summary for no appointments", () => {
    expect(Appointment.summarizeStatuses([])).toEqual({
      total: 0,
      open: 0,
      checkedIn: 0,
      completed: 0,
    })
  })

  it("counts the statuses the appointment editors can write", () => {
    const summary = Appointment.summarizeStatuses([
      "pending",
      "pending",
      "confirmed",
      "checked_in",
      "completed",
      "completed",
      "completed",
      "cancelled",
    ])

    expect(summary).toEqual({ total: 8, open: 3, checkedIn: 1, completed: 3 })
  })

  it("counts department-only statuses alongside their appointment-level equivalents", () => {
    const summary = Appointment.summarizeStatuses(["scheduled", "in_progress"])

    expect(summary).toEqual({ total: 2, open: 1, checkedIn: 1, completed: 0 })
  })

  it("counts cancelled appointments in the total but in no bucket", () => {
    const summary = Appointment.summarizeStatuses(["cancelled", "cancelled"])

    expect(summary).toEqual({ total: 2, open: 0, checkedIn: 0, completed: 0 })
  })

  it("keeps total equal to the input length and never exceeds it in any bucket", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...Appointment.statusList, "something_unrecognised")),
        (statuses) => {
          const summary = Appointment.summarizeStatuses(statuses)

          expect(summary.total).toBe(statuses.length)
          expect(summary.open + summary.checkedIn + summary.completed).toBeLessThanOrEqual(
            summary.total,
          )
        },
      ),
    )
  })
})
