/**
 * `Prescription.DB.create` as an upsert, against a real database.
 *
 * The editor reuses this function to save an edit, so every behaviour that
 * separates "edit" from "create" lives here: items must be updated in place
 * rather than recreated, a dropped item must leave a tombstone, a dispensed
 * item must survive being dropped, and an edit must not re-parent the
 * prescription onto a freshly minted visit.
 *
 * Mocks would assert nothing — the duplication bug this covers is a property of
 * WatermelonDB's prepareCreate/prepareUpdate against the real schema.
 */

import { createTestDatabase, resetTestDatabase } from "../helpers/testDatabase"

jest.mock("@/db", () => ({
  __esModule: true,
  get default() {
    return (global as never as { __TEST_DB__: unknown }).__TEST_DB__
  },
  get database() {
    return (global as never as { __TEST_DB__: unknown }).__TEST_DB__
  },
}))

jest.mock("@hikmahealth/js-utils", () => ({
  Logger: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import type { Database } from "@nozbe/watermelondb"

import type PrescriptionModel from "@/db/model/Prescription"
import type VisitModel from "@/db/model/Visit"
import Prescription from "@/models/Prescription"
import PrescriptionItem from "@/models/PrescriptionItem"

const PATIENT_ID = "patient-1"
const CLINIC_ID = "clinic-1"

const provider = { id: "provider-1", name: "Dr. Test", clinicId: CLINIC_ID }

const prescriptionForm = (over: Partial<Prescription.T> = {}): Prescription.T => ({
  ...Prescription.empty,
  patientId: PATIENT_ID,
  providerId: provider.id,
  pickupClinicId: CLINIC_ID,
  status: "pending",
  priority: "normal",
  notes: "",
  ...over,
})

const itemForm = (over: Partial<PrescriptionItem.T> = {}): PrescriptionItem.T => ({
  ...PrescriptionItem.empty("unsaved"),
  patientId: PATIENT_ID,
  clinicId: CLINIC_ID,
  drugId: "drug-1",
  quantityPrescribed: 1,
  ...over,
})

let db: Database

beforeEach(() => {
  db = createTestDatabase()
  ;(global as never as { __TEST_DB__: Database }).__TEST_DB__ = db
})

afterEach(async () => {
  await resetTestDatabase(db)
})

/** Create a prescription the way the editor's create flow does. */
const createPrescription = async (items: PrescriptionItem.T[]) => {
  const { prescriptionId } = await Prescription.DB.create(
    null,
    prescriptionForm(),
    items,
    provider,
    false,
  )
  return prescriptionId
}

const findPrescription = (id: string) =>
  db.get<PrescriptionModel>(Prescription.DB.table_name).find(id)

describe("Prescription.DB.create — creating", () => {
  it("writes one row per submitted item", async () => {
    const id = await createPrescription([
      itemForm({ drugId: "drug-1" }),
      itemForm({ drugId: "drug-2" }),
    ])

    const items = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(items).toHaveLength(2)
    expect(items.map((item) => item.drugId).sort()).toEqual(["drug-1", "drug-2"])
  })
})

describe("Prescription.DB.create — editing", () => {
  it("does not duplicate items when saved again unchanged", async () => {
    const id = await createPrescription([itemForm({ drugId: "drug-1" })])
    const loaded = await PrescriptionItem.DB.getByPrescriptionId(id)

    await Prescription.DB.create(id, prescriptionForm({ id }), loaded, provider, false)

    const after = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(after).toHaveLength(1)
    expect(after[0].id).toBe(loaded[0].id)
  })

  it("is stable across repeated saves", async () => {
    const id = await createPrescription([itemForm(), itemForm({ drugId: "drug-2" })])

    for (let round = 0; round < 3; round++) {
      const loaded = await PrescriptionItem.DB.getByPrescriptionId(id)
      await Prescription.DB.create(id, prescriptionForm({ id }), loaded, provider, false)
    }

    expect(await PrescriptionItem.DB.getByPrescriptionId(id)).toHaveLength(2)
  })

  it("updates an existing item in place rather than replacing it", async () => {
    const id = await createPrescription([itemForm({ quantityPrescribed: 1 })])
    const [original] = await PrescriptionItem.DB.getByPrescriptionId(id)

    await Prescription.DB.create(
      id,
      prescriptionForm({ id }),
      [{ ...original, quantityPrescribed: 42, dosageInstructions: "twice daily" }],
      provider,
      false,
    )

    const items = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(original.id)
    expect(items[0].quantityPrescribed).toBe(42)
    expect(items[0].dosageInstructions).toBe("twice daily")
  })

  it("adds a newly selected item alongside the existing ones", async () => {
    const id = await createPrescription([itemForm({ drugId: "drug-1" })])
    const loaded = await PrescriptionItem.DB.getByPrescriptionId(id)

    await Prescription.DB.create(
      id,
      prescriptionForm({ id }),
      [...loaded, itemForm({ id: "not-yet-saved", drugId: "drug-2" })],
      provider,
      false,
    )

    const items = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(items.map((item) => item.drugId).sort()).toEqual(["drug-1", "drug-2"])
  })

  it("soft-deletes a removed item so the server sees a tombstone", async () => {
    const id = await createPrescription([
      itemForm({ drugId: "drug-1" }),
      itemForm({ drugId: "drug-2" }),
    ])
    const loaded = await PrescriptionItem.DB.getByPrescriptionId(id)
    const kept = loaded.filter((item) => item.drugId === "drug-1")
    const removed = loaded.find((item) => item.drugId === "drug-2")!

    await Prescription.DB.create(id, prescriptionForm({ id }), kept, provider, false)

    const items = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(items).toHaveLength(1)
    expect(items[0].drugId).toBe("drug-1")

    // A plain query can never see a tombstone, so ask the adapter directly.
    const tombstones = await db.adapter.getDeletedRecords(PrescriptionItem.DB.table_name)
    expect(tombstones).toContain(removed.id)
  })

  it("keeps a dispensed item even when it is dropped from the form", async () => {
    const id = await createPrescription([itemForm({ drugId: "drug-1" })])
    const [item] = await PrescriptionItem.DB.getByPrescriptionId(id)

    await db.write(async () => {
      const record = await db
        .get<PrescriptionItem.DB.T>(PrescriptionItem.DB.table_name)
        .find(item.id)
      await record.update((it) => {
        it.quantityDispensed = 1
      })
    })

    await Prescription.DB.create(id, prescriptionForm({ id }), [], provider, false)

    const items = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(item.id)

    const tombstones = await db.adapter.getDeletedRecords(PrescriptionItem.DB.table_name)
    expect(tombstones).not.toContain(item.id)
  })

  it("never rolls back a dispense that happened while the form was open", async () => {
    const id = await createPrescription([itemForm({ quantityPrescribed: 5 })])
    const [staleCopy] = await PrescriptionItem.DB.getByPrescriptionId(id)

    await db.write(async () => {
      const record = await db
        .get<PrescriptionItem.DB.T>(PrescriptionItem.DB.table_name)
        .find(staleCopy.id)
      await record.update((it) => {
        it.quantityDispensed = 3
      })
    })

    // The form still holds the pre-dispense copy, quantityDispensed = 0.
    await Prescription.DB.create(id, prescriptionForm({ id }), [staleCopy], provider, false)

    const items = await PrescriptionItem.DB.getByPrescriptionId(id)
    expect(items[0].quantityDispensed).toBe(3)
  })

  it("keeps the prescription on its original visit", async () => {
    const visit = await db.write(async () =>
      db.get<VisitModel>("visits").create((newVisit) => {
        newVisit.patientId = PATIENT_ID
        newVisit.clinicId = CLINIC_ID
        newVisit.providerId = provider.id
        newVisit.providerName = provider.name
        newVisit.checkInTimestamp = new Date()
      }),
    )

    const { prescriptionId: id } = await Prescription.DB.create(
      null,
      prescriptionForm({ visitId: visit.id }),
      [itemForm()],
      provider,
      false,
    )
    expect((await findPrescription(id)).visitId).toBe(visit.id)

    // The form submits no visitId and asks for a visit to be created — the
    // shape that used to re-parent the prescription onto a brand new visit.
    await Prescription.DB.create(id, prescriptionForm({ id, visitId: null }), [], provider, true)

    expect((await findPrescription(id)).visitId).toBe(visit.id)
    expect(await db.get<VisitModel>("visits").query().fetchCount()).toBe(1)
  })

  it("records who last edited it without losing the original author", async () => {
    const id = await createPrescription([itemForm()])
    const editor = { id: "provider-2", name: "Dr. Second", clinicId: CLINIC_ID }

    await Prescription.DB.create(id, prescriptionForm({ id }), [], editor, false)

    const record = await findPrescription(id)
    expect(record.providerId).toBe(provider.id)
    expect(record.metadata.lastUpdatedBy).toBe(editor.id)
  })
})
