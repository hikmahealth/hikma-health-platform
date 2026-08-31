import fc from "fast-check"

import Appointment from "../../app/models/Appointment"

const zeroCounts = () =>
  Object.fromEntries(Appointment.statusList.map((status) => [status, 0])) as Record<
    Appointment.Status,
    number
  >

describe("Appointment.summarizeStatuses", () => {
  it("returns an all-zero summary for no appointments", () => {
    expect(Appointment.summarizeStatuses([])).toEqual({
      total: 0,
      byStatus: zeroCounts(),
      unrecognized: 0,
    })
  })

  it("counts every status separately", () => {
    const summary = Appointment.summarizeStatuses([
      "pending",
      "pending",
      "scheduled",
      "checked_in",
      "in_progress",
      "confirmed",
      "cancelled",
      "completed",
      "completed",
      "completed",
    ])

    expect(summary).toEqual({
      total: 10,
      byStatus: {
        pending: 2,
        scheduled: 1,
        checked_in: 1,
        in_progress: 1,
        confirmed: 1,
        cancelled: 1,
        completed: 3,
      },
      unrecognized: 0,
    })
  })

  it("counts a status it does not recognise rather than dropping it", () => {
    const summary = Appointment.summarizeStatuses(["completed", "no_show"])

    expect(summary.total).toBe(2)
    expect(summary.unrecognized).toBe(1)
    expect(summary.byStatus).toEqual({ ...zeroCounts(), completed: 1 })
  })

  it("keeps a bucket for every status the filters offer", () => {
    const summary = Appointment.summarizeStatuses([])

    expect(Object.keys(summary.byStatus).sort()).toEqual([...Appointment.statusList].sort())
  })

  it("splits the total across the status buckets and the unrecognised count", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<string>(...Appointment.statusList, "something_unrecognised")),
        (statuses) => {
          const summary = Appointment.summarizeStatuses(statuses)
          const counted = Object.values(summary.byStatus).reduce((sum, count) => sum + count, 0)

          expect(summary.total).toBe(statuses.length)
          expect(counted + summary.unrecognized).toBe(summary.total)
        },
      ),
    )
  })
})
