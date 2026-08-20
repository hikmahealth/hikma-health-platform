/**
 * The count badge on a patient group is a claim about the whole filtered day,
 * so grouping must never lose or reorder a prescription, and the status
 * breakdown must add back up to the badge.
 */

import Prescription from "@/models/Prescription"

const prescription = (
  id: string,
  patientId: string,
  status: Prescription.Status,
): Prescription.T => ({
  ...Prescription.empty(),
  id,
  patientId,
  status,
})

const totalOf = (statusCounts: readonly Prescription.StatusCount[]) =>
  statusCounts.reduce((sum, { count }) => sum + count, 0)

describe("Prescription.groupByPatient", () => {
  it("returns nothing for an empty result set", () => {
    expect(Prescription.groupByPatient([])).toEqual([])
  })

  it("collects a patient's prescriptions into a single group", () => {
    const groups = Prescription.groupByPatient([
      prescription("p1", "patient-a", "pending"),
      prescription("p2", "patient-b", "pending"),
      prescription("p3", "patient-a", "prepared"),
      prescription("p4", "patient-a", "pending"),
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0].patientId).toBe("patient-a")
    expect(groups[0].prescriptions.map((item) => item.id)).toEqual(["p1", "p3", "p4"])
    expect(groups[1].prescriptions.map((item) => item.id)).toEqual(["p2"])
  })

  it("keeps patients in the order they first appear", () => {
    const groups = Prescription.groupByPatient([
      prescription("p1", "patient-c", "pending"),
      prescription("p2", "patient-a", "pending"),
      prescription("p3", "patient-c", "pending"),
      prescription("p4", "patient-b", "pending"),
    ])

    expect(groups.map((group) => group.patientId)).toEqual(["patient-c", "patient-a", "patient-b"])
  })

  it("counts every prescription exactly once", () => {
    const groups = Prescription.groupByPatient([
      prescription("p1", "patient-a", "pending"),
      prescription("p2", "patient-a", "prepared"),
      prescription("p3", "patient-a", "pending"),
      prescription("p4", "patient-b", "picked-up"),
    ])

    expect(totalOf(groups[0].statusCounts)).toBe(groups[0].prescriptions.length)
    expect(totalOf(groups[1].statusCounts)).toBe(groups[1].prescriptions.length)
  })

  it("orders the status breakdown by the canonical status list", () => {
    const groups = Prescription.groupByPatient([
      prescription("p1", "patient-a", "cancelled"),
      prescription("p2", "patient-a", "pending"),
      prescription("p3", "patient-a", "prepared"),
      prescription("p4", "patient-a", "pending"),
    ])

    expect(groups[0].statusCounts).toEqual([
      { status: "pending", count: 2 },
      { status: "prepared", count: 1 },
      { status: "cancelled", count: 1 },
    ])
  })

  it("still counts a status outside the canonical list", () => {
    const drifted = "unknown-status" as Prescription.Status
    const groups = Prescription.groupByPatient([
      prescription("p1", "patient-a", "pending"),
      prescription("p2", "patient-a", drifted),
    ])

    expect(groups[0].statusCounts).toEqual([
      { status: "pending", count: 1 },
      { status: drifted, count: 1 },
    ])
    expect(totalOf(groups[0].statusCounts)).toBe(2)
  })
})

describe("Prescription.describeStatusCounts", () => {
  it("is empty when there is nothing to describe", () => {
    expect(Prescription.describeStatusCounts([])).toBe("")
  })

  it("reads as a plain breakdown with hyphenated statuses spelled out", () => {
    expect(
      Prescription.describeStatusCounts([
        { status: "pending", count: 2 },
        { status: "picked-up", count: 1 },
      ]),
    ).toBe("2 pending · 1 picked up")
  })
})
