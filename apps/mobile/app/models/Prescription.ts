import { Model, Q } from "@nozbe/watermelondb"
import * as Sentry from "@sentry/react-native"
import { addDays } from "date-fns"

import database from "@/db"
import PrescriptionModel from "@/db/model/Prescription"
import VisitModel from "@/db/model/Visit"
import { buildPrefilter, tokenizeForSearch } from "@/utils/parsers"

import PrescriptionItem from "./PrescriptionItem"
import User from "./User"
import { Logger } from "@hikmahealth/js-utils"

namespace Prescription {
  export const Priority = {
    HIGH: "high",
    LOW: "low",
    NORMAL: "normal",
    EMERGENCY: "emergency",
  } as const
  export const priorityList: (typeof Priority)[keyof typeof Priority][] = [
    "high",
    "low",
    "normal",
    "emergency",
  ]
  export const Status = {
    PENDING: "pending",
    PREPARED: "prepared", // same as FILLED
    FILLED: "prepared",
    PICKED_UP: "picked-up",
    NOT_PICKED_UP: "not-picked-up",
    PARTIALLY_PICKED_UP: "partially-picked-up",
    CANCELLED: "cancelled",
    EXPIRED: "expired",
    OTHER: "other",
  } as const
  export const statusList: (typeof Status)[keyof typeof Status][] = [
    "pending",
    "prepared",
    "picked-up",
    "expired",

    "not-picked-up",
    "partially-picked-up",
    "cancelled",
    "other",
  ]
  export type Priority = (typeof Priority)[keyof typeof Priority]
  export type Status = (typeof Status)[keyof typeof Status]

  export type DBModel = PrescriptionModel

  export const Route = {
    ORAL: "oral",
    SUBLINGUAL: "sublingual",
    RECTAL: "rectal",
    TOPICAL: "topical",
    INHALATION: "inhalation",
    INTRAVENOUS: "intravenous",
    INTRAMUSCULAR: "intramuscular",
    INTRADERMAL: "intradermal",
    SUBCUTANEOUS: "subcutaneous",
    NASAL: "nasal",
    OPHTHALMIC: "ophthalmic",
    OTIC: "otic",
    VAGINAL: "vaginal",
    TRANSDERMAL: "transdermal",
    OTHER: "other",
  }
  export const routeList: (typeof Route)[keyof typeof Route][] = [
    "oral",
    "sublingual",
    "rectal",
    "topical",
    "inhalation",
    "intravenous",
    "intramuscular",
    "intradermal",
    "subcutaneous",
    "nasal",
    "ophthalmic",
    "otic",
    "vaginal",
    "transdermal",
    "other",
  ]
  export type Route = (typeof Route)[keyof typeof Route]

  export const Form = {
    TABLET: "tablet",
    SYRUP: "syrup",
    AMPULE: "ampule",
    SUPPOSITORY: "suppository",
    CREAM: "cream",
    DROPS: "drops",
    BOTTLE: "bottle",
    SPRAY: "spray",
    GEL: "gel",
    LOTION: "lotion",
    INHALER: "inhaler",
    CAPSULE: "capsule",
    INJECTION: "injection",
    PATCH: "patch",
    OTHER: "other",
  }
  export const formList: (typeof Form)[keyof typeof Form][] = [
    "tablet",
    "syrup",
    "ampule",
    "suppository",
    "cream",
    "drops",
    "bottle",
    "spray",
    "gel",
    "lotion",
    "inhaler",
    "capsule",
    "injection",
    "patch",
    "other",
  ]
  export type Form = (typeof Form)[keyof typeof Form]

  export const DurationUnit = {
    HOURS: "hours",
    DAYS: "days",
    WEEKS: "weeks",
    MONTHS: "months",
    YEARS: "years",
  }
  export const durationUnitList: (typeof DurationUnit)[keyof typeof DurationUnit][] = [
    "hours",
    "days",
    "weeks",
    "months",
    "years",
  ]
  export type DurationUnit = (typeof DurationUnit)[keyof typeof DurationUnit]

  export const DoseUnit = {
    MG: "mg",
    G: "g",
    MCG: "mcg",
    ML: "mL",
    L: "L",
    UNITS: "units",
  }
  export const doseUnitList: (typeof DoseUnit)[keyof typeof DoseUnit][] = [
    "mg",
    "g",
    "mcg",
    "mL",
    "L",
    "units",
  ]
  export type DoseUnit = (typeof DoseUnit)[keyof typeof DoseUnit]

  export type MedicationEntry = {
    id: string
    name: string
    route: Route
    form: Form
    frequency: number
    intervals: number
    dose: number
    doseUnits: DoseUnit
    duration: number
    durationUnits: DurationUnit
  }

  export type Item = MedicationEntry & {
    medicationId: string
    quantity: number
    status: Status
    priority: Priority
    filledAt: Date | null
    filledByUserId: string | null
  }

  export type T = {
    id: string
    patientId: string
    providerId: string
    filledBy: string | null
    pickupClinicId: string | null
    visitId: string | null
    priority: Priority
    status: Status
    /** @deprecated - use the PrescriptionItem db to store these */
    items: Item[]
    notes: string
    expirationDate: Date
    prescribedAt: Date
    filledAt: Date | null
    metadata: Record<string, any>
    isDeleted: boolean
    deletedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }

  /** How long a prescription stays valid when no expiry is given explicitly. */
  const DEFAULT_VALIDITY_DAYS = 90

  /** The expiry a prescription written at `prescribedAt` carries by default. */
  export const defaultExpirationDate = (prescribedAt: Date): Date =>
    addDays(prescribedAt, DEFAULT_VALIDITY_DAYS)

  /**
   * A blank prescription for a form to start from.
   *
   * A function, not a constant: a constant freezes its timestamps at import.
   * `prescribedAt` is a placeholder — the saved value is minted at submit.
   */
  export const empty = (): T => {
    const prescribedAt = new Date()

    return {
      id: "",
      patientId: "",
      providerId: "",
      filledBy: null,
      pickupClinicId: null,
      visitId: null,
      priority: "normal",
      status: "pending",
      items: [],
      notes: "",
      expirationDate: defaultExpirationDate(prescribedAt),
      prescribedAt,
      filledAt: null,
      metadata: {},
      isDeleted: false,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  export type PrescriptionForm = {
    patientId: string
    pickupClinicId?: string | null
    visitId?: string | null
    priority: Priority
    status: Status
    filledBy?: string | null
    expirationDate: Date
    prescribedAt: Date
    filledAt?: Date | null
    notes: string
    items: Item[]
    metadata?: Record<string, any>
  }

  /** How many prescriptions in a group carry one status. */
  export type StatusCount = {
    readonly status: Status
    readonly count: number
  }

  /** Every prescription one patient has within a single filtered result set. */
  export type PatientGroup = {
    readonly patientId: string
    readonly prescriptions: readonly T[]
    readonly statusCounts: readonly StatusCount[]
  }

  const countByStatus = (prescriptions: readonly T[]): StatusCount[] => {
    const counts = new Map<Status, number>()
    for (const prescription of prescriptions) {
      counts.set(prescription.status, (counts.get(prescription.status) ?? 0) + 1)
    }

    // Known statuses first for a fixed order, then any drifted value, so
    // nothing is dropped from a breakdown that claims to cover the group.
    const known = statusList.filter((status) => counts.has(status))
    const unknown = Array.from(counts.keys()).filter((status) => !statusList.includes(status))

    return [...known, ...unknown].map((status) => ({ status, count: counts.get(status) ?? 0 }))
  }

  /**
   * One group per patient, preserving input order at both levels.
   *
   * The counts describe exactly the prescriptions passed in, so callers must
   * pass a complete result set rather than a page of one.
   */
  export const groupByPatient = (prescriptions: readonly T[]): PatientGroup[] => {
    const byPatient = new Map<string, T[]>()

    for (const prescription of prescriptions) {
      const existing = byPatient.get(prescription.patientId)
      if (existing) {
        existing.push(prescription)
        continue
      }
      byPatient.set(prescription.patientId, [prescription])
    }

    return Array.from(byPatient, ([patientId, grouped]) => ({
      patientId,
      prescriptions: grouped,
      statusCounts: countByStatus(grouped),
    }))
  }

  /** A one-line breakdown of a group's statuses, e.g. "2 pending · 1 picked up". */
  export const describeStatusCounts = (statusCounts: readonly StatusCount[]): string =>
    statusCounts.map(({ status, count }) => `${count} ${status.replaceAll("-", " ")}`).join(" · ")

  export namespace DB {
    export type T = PrescriptionModel
    export const table_name = "prescriptions"
    /**
     * The prescription with this id, or null when there is no such row.
     * Anything that is not a lookup miss is rethrown.
     */
    const findExisting = async (id: string | null): Promise<PrescriptionModel | null> => {
      if (!id) return null
      try {
        return await database.get<PrescriptionModel>(table_name).find(id)
      } catch (err: any) {
        if (err?.message?.includes("not found") || err?.message?.includes("find")) {
          return null
        }
        throw err
      }
    }

    /**
     * Prepared writes that make a prescription's items match `submittedItems`.
     *
     * Items already on the prescription are updated in place rather than
     * recreated: recreating them duplicates every item on each save and strands
     * the dispensing history, which is keyed to the original item ids.
     *
     * A dropped item is soft-deleted so the server receives a tombstone —
     * unless some of it has already been dispensed, in which case the row
     * records medication that physically left the pharmacy and is kept.
     */
    const reconcileItems = ({
      existingItems,
      submittedItems,
      prescriptionId,
      patientId,
      providerId,
    }: {
      existingItems: readonly PrescriptionItem.DB.T[]
      submittedItems: readonly PrescriptionItem.T[]
      prescriptionId: string
      patientId: string
      providerId: string
    }): Model[] => {
      const collection = database.get<PrescriptionItem.DB.T>(PrescriptionItem.DB.table_name)
      const existingById = new Map(existingItems.map((item) => [item.id, item]))
      const submittedIds = new Set(submittedItems.map((item) => item.id))

      const writes: Model[] = []

      for (const item of submittedItems) {
        const existing = existingById.get(item.id)

        if (existing) {
          // Only the fields the editor owns. quantityDispensed, refillsUsed and
          // itemStatus are advanced by the dispensing flow, so writing the
          // form's copy back would undo a dispense that happened meanwhile.
          writes.push(
            existing.prepareUpdate((record) => {
              record.drugId = item.drugId
              record.clinicId = item.clinicId
              record.dosageInstructions = item.dosageInstructions
              record.quantityPrescribed = item.quantityPrescribed
              record.notes = item.notes
            }),
          )
          continue
        }

        writes.push(
          collection.prepareCreate((newItem) => {
            newItem.prescriptionId = prescriptionId
            newItem.patientId = patientId
            newItem.drugId = item.drugId
            newItem.clinicId = item.clinicId
            newItem.dosageInstructions = item.dosageInstructions
            newItem.quantityPrescribed = item.quantityPrescribed
            newItem.quantityDispensed = item.quantityDispensed
            newItem.refillsAuthorized = item.refillsAuthorized
            newItem.refillsUsed = item.refillsUsed
            newItem.itemStatus = item.itemStatus
            newItem.notes = item.notes
            newItem.recordedByUserId = providerId
            newItem.metadata = item.metadata || {}
          }),
        )
      }

      for (const existing of existingItems) {
        if (submittedIds.has(existing.id)) continue
        if (existing.quantityDispensed > 0) continue
        writes.push(existing.prepareMarkAsDeleted())
      }

      return writes
    }

    /**
     * Create a prescription, or update it when `prescriptionId` names one that
     * already exists. Its items are reconciled either way.
     */
    export const create = async (
      prescriptionId: string | null,
      prescription: Prescription.T,
      prescriptionItems: PrescriptionItem.T[],
      provider: {
        id: string
        name: string
        clinicId: string
      },
      shouldCreateNewVisit: boolean = false,
    ): Promise<{ visitId: string | null; prescriptionId: string }> => {
      return await database.write(async () => {
        // Resolved before the visit lookup because an edit must not mint a new
        // visit: doing so would silently re-parent the prescription onto it.
        const existingPrescription = await findExisting(prescriptionId)

        let dbVisitId: string | null = null
        let dbVisit: VisitModel | null = null

        try {
          const visit = await database.get<VisitModel>("visits").find(prescription.visitId || "")
          if (visit) {
            dbVisitId = visit.id
          } else {
            throw new Error("Visit not found")
          }
        } catch (err: any) {
          if (existingPrescription) {
            // Editing: keep whichever visit it already belongs to.
            dbVisitId = existingPrescription.visitId || null
          } else if (shouldCreateNewVisit === true) {
            if (err?.message?.includes("not found") || err?.message?.includes("find")) {
              const visitClinicId = prescription.pickupClinicId || provider.clinicId
              dbVisit = database.get<VisitModel>("visits").prepareCreate((newVisit) => {
                newVisit.patientId = prescription.patientId
                if (visitClinicId !== null) newVisit.clinicId = visitClinicId
                newVisit.providerId = provider.id
                newVisit.providerName = provider.name
                newVisit.checkInTimestamp = new Date()
              })
              dbVisitId = dbVisit.id
            } else {
              throw err
            }
          }
        }

        let dbPrescription: PrescriptionModel

        if (existingPrescription) {
          dbPrescription = existingPrescription.prepareUpdate((updatedPrescription) => {
            updatedPrescription.patientId = prescription.patientId
            updatedPrescription.pickupClinicId = prescription.pickupClinicId || null
            updatedPrescription.visitId = dbVisitId || null
            updatedPrescription.priority = prescription.priority
            updatedPrescription.status = prescription.status
            updatedPrescription.filledBy = prescription.filledBy || null
            updatedPrescription.expirationDate = prescription.expirationDate
            updatedPrescription.prescribedAt = prescription.prescribedAt
            updatedPrescription.filledAt = prescription.filledAt || null
            updatedPrescription.notes = prescription.notes
            // items are deprecated
            updatedPrescription.metadata = {
              ...(prescription.metadata || {}),
              lastUpdatedBy: provider.id,
              lastUpdatedByName: provider.name,
            }
          })
        } else {
          dbPrescription = database
            .get<PrescriptionModel>(table_name)
            .prepareCreate((newPrescription) => {
              newPrescription.patientId = prescription.patientId
              newPrescription.providerId = provider.id
              newPrescription.pickupClinicId = prescription.pickupClinicId || null
              newPrescription.visitId = dbVisitId || null
              newPrescription.priority = prescription.priority
              newPrescription.status = prescription.status
              newPrescription.filledBy = prescription.filledBy || null
              newPrescription.expirationDate = prescription.expirationDate
              newPrescription.prescribedAt = prescription.prescribedAt
              newPrescription.filledAt = prescription.filledAt || null
              newPrescription.notes = prescription.notes
              // items are deprecated
              newPrescription.metadata = {
                ...(prescription.metadata || {}),
                providerId: provider.id,
                providerName: provider.name,
              }
            })
        }

        const existingItems = existingPrescription
          ? await database
              .get<PrescriptionItem.DB.T>(PrescriptionItem.DB.table_name)
              .query(Q.where("prescription_id", existingPrescription.id))
              .fetch()
          : []

        const dbPrescriptionItems = reconcileItems({
          existingItems,
          submittedItems: prescriptionItems,
          prescriptionId: dbPrescription.id,
          patientId: prescription.patientId,
          providerId: provider.id,
        })

        const changesBatch = [dbVisit, dbPrescription, ...dbPrescriptionItems].filter(
          Boolean,
        ) as Model[]
        await database.batch(changesBatch)

        return {
          visitId: dbVisitId,
          prescriptionId: dbPrescription.id,
        }
      })
    }

    /** Update the status of a prescription. */
    export const updateStatus = async (prescriptionId: string, status: Status): Promise<void> => {
      await database.write(async () => {
        const prescriptionRecord = await database
          .get<Prescription.DB.T>(Prescription.DB.table_name)
          .find(prescriptionId)

        if (!prescriptionRecord) return

        await prescriptionRecord.update((newPrescription) => {
          newPrescription.status = status
        })
      })
    }

    /**
     * Marks a prescription as picked up. Prescriptions marked as picked up cannot be edited.
     *
     * Sets the pickup dates, then draws the dispensed amounts down from the
     * batch inventory.
     */
    export const markAsPickedUp = async (
      prescriptionId: string,
      provider: { id: string },
    ): Promise<void> => {
      await database.write(async () => {
        const prescriptionRecord = await database
          .get<Prescription.DB.T>(Prescription.DB.table_name)
          .find(prescriptionId)

        if (!prescriptionRecord) return

        await prescriptionRecord.prepareUpdate((newPrescription) => {
          newPrescription.status = "picked-up"
          newPrescription.filledAt = new Date()
          newPrescription.filledBy = provider.id
        })
      })
    }

    /**
     * @deprecated Writes only the fields present in the partial, and never
     * touches items. `create` is the upsert the editor uses.
     */
    export const updatePrescription = async (
      prescriptionId: string,
      prescription: Partial<PrescriptionForm>,
      provider: User.Provider,
    ): Promise<{ visitId: string | null; prescriptionId: string }> => {
      return await database.write(async () => {
        const prescriptionRecord = await database
          .get<PrescriptionModel>(table_name)
          .find(prescriptionId)

        const updatedPrescription = prescriptionRecord.prepareUpdate((updatedPrescription) => {
          // patientId, providerId, clinicId and visitId are immutable after creation.
          if (prescription.pickupClinicId !== undefined)
            updatedPrescription.pickupClinicId = prescription.pickupClinicId
          if (prescription.priority !== undefined)
            updatedPrescription.priority = prescription.priority
          if (prescription.status !== undefined) updatedPrescription.status = prescription.status
          if (prescription.expirationDate !== undefined)
            updatedPrescription.expirationDate = prescription.expirationDate
          if (prescription.prescribedAt !== undefined)
            updatedPrescription.prescribedAt = prescription.prescribedAt
          if (prescription.filledAt !== undefined)
            updatedPrescription.filledAt = prescription.filledAt
          if (prescription.notes !== undefined) updatedPrescription.notes = prescription.notes
          if (prescription.items !== undefined) updatedPrescription.items = prescription.items

          // TODO: Determine how to handle the filledBy field
          updatedPrescription.metadata = {
            ...(prescription.metadata || {}),
            lastUpdatedBy: provider.id,
            lastUpdatedByName: provider.name,
          }
        })

        let visitUpdate: VisitModel | null = null
        try {
          if (updatedPrescription.visitId) {
            const visitRecord = await database
              .get<VisitModel>("visits")
              .find(updatedPrescription.visitId)
            if (visitRecord) {
              visitUpdate = visitRecord.prepareUpdate((updatedVisit) => {
                updatedVisit.metadata = Object.assign({}, updatedVisit.metadata, {
                  lastUpdatedBy: provider.id,
                  lastUpdatedByName: provider.name,
                })
              })
            }
          }
        } catch (error) {
          Logger.error(error)
          Sentry.captureException(error, {
            level: "error",
            extra: {
              prescriptionId,
              prescription,
              visitId: updatedPrescription.visitId,
            },
          })
        }

        const updateBatch = [updatedPrescription, visitUpdate].filter(Boolean) as Model[]
        await database.batch(updateBatch)

        return {
          visitId: visitUpdate?.id || null,
          prescriptionId: updatedPrescription.id,
        }
      })
    }

    /**
     * Create query conditions for searching prescriptions
     *
     * `clinicIds` is the pickup-clinic constraint: `null` applies none, while
     * an empty array matches nothing. `pickup_clinic_id` is nullable, so the
     * two are not interchangeable — see `Clinic.resolveClinicIdConstraint`.
     */
    export const createSearchQueryConditions = (
      searchQuery: string,
      clinicIds: string[] | null,
      status: Status[],
      date: Date,
      options: { offset?: number; limit?: number } = { offset: 0, limit: 50 },
    ): Q.Clause[] => {
      const conditions: Q.Clause[] = [Q.where("is_deleted", false)]

      if (clinicIds !== null) {
        conditions.push(Q.where("pickup_clinic_id", Q.oneOf(clinicIds)))
      }

      const startOfDay = new Date(date)
      startOfDay.setHours(0, 0, 0, 0)
      const endOfDay = new Date(date)
      endOfDay.setHours(23, 59, 59, 999)

      conditions.push(
        Q.where("prescribed_at", Q.gte(startOfDay.getTime())),
        Q.where("prescribed_at", Q.lte(endOfDay.getTime())),
      )

      if (status.length > 0) {
        conditions.push(Q.where("status", Q.oneOf(status)))
      }

      const nameTokens = tokenizeForSearch(searchQuery)
      if (nameTokens.length > 0) {
        conditions.push(
          Q.experimentalJoinTables(["patients"]),
          Q.or(
            ...nameTokens.flatMap((token) => [
              Q.on("patients", "given_name", Q.like(buildPrefilter(token))),
              Q.on("patients", "surname", Q.like(buildPrefilter(token))),
            ]),
          ),
        )
      }

      const { offset = 0, limit = 50 } = options
      if (offset > 0) {
        conditions.push(Q.skip(offset))
      }
      if (limit > 0) {
        conditions.push(Q.take(limit))
      }

      return conditions
    }

    export function rawToT(rawPrescription: PrescriptionModel): Prescription.T {
      return {
        id: rawPrescription.id,
        patientId: rawPrescription.patientId,
        providerId: rawPrescription.providerId,
        filledBy: rawPrescription.filledBy || null,
        pickupClinicId: rawPrescription.pickupClinicId || null,
        visitId: rawPrescription.visitId || null,
        priority: rawPrescription.priority,
        status: rawPrescription.status,
        items: rawPrescription.items,
        notes: rawPrescription.notes,
        expirationDate: rawPrescription.expirationDate,
        prescribedAt: rawPrescription.prescribedAt,
        filledAt: rawPrescription.filledAt || null,
        metadata: rawPrescription.metadata,
        isDeleted: rawPrescription.isDeleted,
        deletedAt: rawPrescription.deletedAt || null,
        createdAt: rawPrescription.createdAt,
        updatedAt: rawPrescription.updatedAt,
      }
    }
  }
}

export default Prescription
