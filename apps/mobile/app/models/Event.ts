import * as Sentry from "@sentry/react-native"
import { Q } from "@nozbe/watermelondb"
import { Option } from "effect"
import { upperFirst } from "es-toolkit/compat"

import database from "@/db"
import EventModel from "@/db/model/Event"
import VisitModel from "@/db/model/Visit"

import ICDEntry from "./ICDEntry"
import { isValid } from "date-fns"
import { Logger } from "@hikmahealth/js-utils"
import * as Problems from "@hikmahealth/forms/Problems"
import { displayDateValue } from "@/utils/date"
import { escapeHtml } from "@/utils/html"
import { isValidUUID } from "@/utils/misc"
import EventForm from "./EventForm"
import PatientProblems from "./PatientProblems"
import PatientProblemModel from "@/db/model/PatientProblems"

namespace Event {
  /**
   * One uploaded file on a file field. `id` is the resource id — the sole
   * authorization key; `fileName` and `mimetype` are display metadata only.
   */
  export type Attachment = {
    id: string
    fileName: string | null
    mimetype: string | null
  }

  export type FormDataItem =
    | {
        inputType: string
        fieldType: "medicine" | string
        name: string
        value: string | number | Date | any[]
        fieldId: string
        // File fields only. `value` holds the resource ids — the authz key;
        // `attachments` carries display metadata keyed by that id.
        attachments?: Attachment[]
      }
    | {
        inputType: string
        fieldType: "diagnosis"
        name: string
        value: ICDEntry.T[]
        fieldId: string
      }
  export type T = {
    id: string
    patientId: string
    visitId: string
    eventType: string
    formId: string
    formData: FormDataItem[]
    metadata: Record<string, any>
    isDeleted: boolean
    deletedAt: Option.Option<Date>
    recordedByUserId: string | null
    createdAt: Date
    updatedAt: Date
  }

  export type DBEvent = EventModel

  /** Default empty Event Item */
  export const empty: T = {
    id: "",
    patientId: "",
    visitId: "",
    eventType: "",
    formId: "",
    formData: [],
    metadata: {},
    isDeleted: false,
    deletedAt: Option.none(),
    recordedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  /**
   * Read the attachments off a file field's `form_data` entry.
   *
   * `value` holds the resource ids and is the authority on which files the
   * field has; `attachments` supplies display metadata, joined by id. An id
   * with no matching metadata record yields null name and mimetype, which the
   * viewer renders as a generic attachment.
   *
   * Total by construction: any absent, empty, or non-array `value` reads as no
   * attachments, so callers never branch on shape.
   */
  export const readAttachments = (field: Partial<FormDataItem>): Attachment[] => {
    const { value } = field
    if (!Array.isArray(value)) return []

    const metadataById = new Map<string, Attachment>()
    const attachments = (field as { attachments?: Attachment[] }).attachments
    if (Array.isArray(attachments)) {
      for (const entry of attachments) {
        if (entry && typeof entry.id === "string") metadataById.set(entry.id, entry)
      }
    }

    // Deduped: `value` is a set of resource ids. A repeat carries no meaning
    // downstream and would collide as a render key.
    const seen = new Set<string>()
    const attached: Attachment[] = []
    for (const id of value) {
      if (typeof id !== "string" || id.length === 0) continue
      if (seen.has(id)) continue
      seen.add(id)
      attached.push({
        id,
        fileName: metadataById.get(id)?.fileName ?? null,
        mimetype: metadataById.get(id)?.mimetype ?? null,
      })
    }
    return attached
  }

  /**
   * Get the display for the event, based on the event type, for the formatted dynamic fields of formData
   * THIS IS ONLY USED FOR PRINTING OUT A HTML BASED REPORT
   * @param {Event} event - The event object
   * @param {string} language - The language code
   * @returns {JSX.Element} - The JSX element to display
   */
  export const getHtmlEventDisplay = (event: Event.T, language: string): string => {
    const { eventType, formData } = event

    let display = ""

    formData.forEach((field, idx) => {
      const { fieldId, fieldType, inputType, name, value } = field

      // Every field name and value below is clinician-entered and arrives over
      // sync, so none of it reaches the template unescaped.
      display += `<div style="margin: 5px 0px;">`
      display += `<span style="text-decoration: underline;">${escapeHtml(name)}:</span>`

      if (fieldType === "diagnosis") {
        if (Array.isArray(value)) {
          value?.forEach((val) => {
            display += `<div>${escapeHtml(ICDEntry.ICD10RecordLabel(val, language))}</div>`
          })
        }
      } else if (inputType === "input-group" && fieldType === "medicine") {
        if (Array.isArray(value)) {
          value.forEach((med) => {
            display += `<div>${escapeHtml(med?.dose)} ${escapeHtml(med?.doseUnits)}</div>`
            display += `<div>${escapeHtml(upperFirst(med?.route || ""))} ${escapeHtml(
              upperFirst(med?.form || ""),
            )}: ${escapeHtml(med?.frequency)}</div>`
          })
        }
      } else if (inputType === "file") {
        // A printed report cannot carry the files. The count also keeps
        // user-supplied filenames out of the HTML.
        const fileCount = readAttachments(field).length
        display += `<div>${fileCount} ${fileCount === 1 ? "file" : "files"}</div>`
      } else if (fieldType !== "diagnosis" && inputType !== "input-group") {
        display += `<div>${escapeHtml(fieldType === "date" ? displayDateValue(value) : value)}</div>`
      }

      display += `</div>`
    })

    return display
  }

  export namespace DB {
    export type T = EventModel

    /**
     * The authored fields of an event's form, which carry the per-field
     * `addToProblems` opt-in. A form that cannot be loaded yields no fields, so
     * nothing is recorded.
     */
    const loadFormFields = async (formId: string): Promise<EventForm.FieldItem[]> => {
      const form = await EventForm.DB.findById(formId)
      return form === null ? [] : form.formFields
    }

    /**
     * The problems a given event has already put on the patient's chart.
     *
     * They are found by `metadata.eventId` — a JSON field, so the filtering
     * happens here rather than in the query. A patient's problem list is small
     * enough for that to be the cheaper trade against a schema change.
     */
    const problemsRecordedByEvent = async (
      patientId: string,
      eventId: string,
    ): Promise<PatientProblemModel[]> => {
      const problems = await database
        .get<PatientProblemModel>("patient_problems")
        .query(Q.where("patient_id", patientId), Q.where("is_deleted", false))
        .fetch()

      return problems.filter((problem) => problem.metadata?.eventId === eventId)
    }

    /**
     * Build the writes that bring an event's recorded problems in line with
     * its current diagnoses: new diagnoses are added, removed ones are marked
     * deleted so the server soft-deletes them on the next sync push.
     *
     * @returns Unsaved operations for the caller's `database.batch`
     */
    const reconcileProblems = async (input: {
      eventId: string
      patientId: string
      visitId: string | undefined
      providerId: string
      desired: Problems.problem[]
      alreadyRequested: Problems.problem[]
    }): Promise<PatientProblemModel[]> => {
      const existing = await problemsRecordedByEvent(input.patientId, input.eventId)

      const { toCreate, toRemoveIds } = Problems.diffProblems(
        existing.map((problem) => ({
          id: problem.id,
          code: problem.problemCode,
          label: problem.problemLabel,
        })),
        input.desired,
        input.alreadyRequested,
      )
      const removing = new Set(toRemoveIds)

      return [
        ...toCreate.map((problem) =>
          newProblemRecord({
            eventId: input.eventId,
            patientId: input.patientId,
            visitId: input.visitId,
            providerId: input.providerId,
            problem,
          }),
        ),
        ...existing
          .filter((problem) => removing.has(problem.id))
          .map((problem) => problem.prepareMarkAsDeleted()),
      ]
    }

    /** One unsaved `patient_problems` row for a diagnosis recorded on an event. */
    const newProblemRecord = (input: {
      eventId: string
      patientId: string
      visitId: string | undefined
      providerId: string
      problem: Problems.problem
    }): PatientProblemModel => {
      const row = Problems.toNewProblem(input.problem)
      return PatientProblems.DB.prepareCreate({
        patientId: input.patientId,
        visitId: input.visitId,
        recordedByUserId: input.providerId,
        problemCodeSystem: row.codeSystem,
        problemCode: row.code,
        problemLabel: row.label,
        clinicalStatus: row.clinicalStatus,
        verificationStatus: row.verificationStatus,
        metadata: { eventId: input.eventId },
      })
    }

    /**
     * Create a new event in the database, also create a new visit if the visitId is not provided
     * @param {Event} event
     * @param {string | null} visitId
     * @param {string} clinicId
     * @param {string} providerId
     * @param {string} providerName
     * @param {number} checkInTimestamp
     * @param {string | null | undefined} eventId - if defined we are going to update that event
     * @returns {Promise<{eventId: string, visitId: string}>}
     * @throws if clinicId is not a valid UUID
     */
    export const create = async (
      event: Omit<EventModel, "id" | "createdAt" | "updatedAt">,
      visitId: string | null,
      clinicId: string,
      providerId: string,
      providerName: string,
      checkInTimestamp: number,
      eventId?: string | null | undefined,
    ): Promise<{ eventId: string; visitId: string }> => {
      // Rejected before any write: an event with no clinic cannot be attributed
      // to a facility, and an empty clinicId used to reach PostgreSQL as "",
      // failing the whole sync push rather than this one record.
      if (!isValidUUID(clinicId)) {
        throw new Error(`Cannot create an event without a valid clinic_id (got "${clinicId}")`)
      }
      // TODO: update the visit to show the new updated at time.
      if (eventId && eventId !== "" && visitId && visitId !== "") {
        const formFields = await loadFormFields(event.formId)
        const projection = Problems.problemsFromFormData(event.formData, formFields)

        const res = await database.write(async () => {
          const eventQuery = await database.get<EventModel>("events").find(eventId)
          if (!eventQuery) {
            throw new Error("Event not found")
          }

          // Read before the update overwrites it: the diagnoses this event
          // asked to record last time.
          const alreadyRequested = Problems.problemsFromFormData(
            eventQuery.formData,
            formFields,
          ).problems

          const eventUpdate = eventQuery.prepareUpdate((newEvent) => {
            newEvent.formId = event.formId
            newEvent.formData = event.formData
            newEvent.metadata = event.metadata
            if (!event.recordedByUserId) {
              newEvent.recordedByUserId = providerId || null
            }
          })

          // A form that does not record problems leaves the list untouched:
          // problems recorded while the flag was on stay on the chart.
          const problemOperations = projection.recordsProblems
            ? await reconcileProblems({
                eventId,
                patientId: event.patientId,
                visitId,
                providerId,
                desired: projection.problems,
                alreadyRequested,
              })
            : []

          await database.batch(eventUpdate, ...problemOperations)
          return eventQuery
        })

        return { eventId: res.id, visitId }
      }

      /** If there is no event Id, we are creating a new event */
      const projection = Problems.problemsFromFormData(event.formData, await loadFormFields(event.formId))

      return await database.write(async () => {
        let visitQuery: VisitModel | null = null
        // If there is no visitId, we are creating a new visit
        if (!event.visitId || event.visitId === "" || visitId === null) {
          visitQuery = database.get<VisitModel>("visits").prepareCreate((newVisit) => {
            newVisit.patientId = event.patientId
            newVisit.clinicId = clinicId
            newVisit.providerId = providerId
            newVisit.providerName = providerName
            newVisit.checkInTimestamp = isValid(checkInTimestamp)
              ? new Date(checkInTimestamp)
              : new Date()
            newVisit.metadata = event.metadata
          })
        } else {
          try {
            const visit = await database.get<VisitModel>("visits").find(visitId)
            visitQuery = visit.prepareUpdate((visit) => {
              visit.metadata = {
                ...visit.metadata,
                lastEventAddedTimestamp: new Date().toISOString(),
              }
            })
          } catch (error) {
            Logger.error(error)
            Sentry.captureException(error, {
              level: "error",
              extra: {
                visitId,
                eventId,
                event,
              },
            })
          }
        }
        const eventQuery = database.get<EventModel>("events").prepareCreate((newEvent) => {
          newEvent.patientId = event.patientId
          newEvent.formId = event.formId
          newEvent.visitId = visitQuery !== null ? visitQuery.id : event.visitId
          newEvent.eventType = event.eventType
          newEvent.formData = event.formData
          newEvent.metadata = {
            ...event.metadata,
            providerId,
            providerName,
          }
          newEvent.isDeleted = event.isDeleted
          newEvent.recordedByUserId = providerId || null
        })

        const problemQueries = projection.problems.map((problem) =>
          newProblemRecord({
            eventId: eventQuery.id,
            patientId: event.patientId,
            visitId: visitQuery !== null ? visitQuery.id : event.visitId,
            providerId,
            problem,
          }),
        )

        // One batch, so an event never reaches the chart without its problems.
        // `batch` ignores a null visit.
        await database.batch(visitQuery, ...problemQueries, eventQuery)

        return {
          eventId: eventQuery.id,
          visitId: visitQuery !== null ? visitQuery.id : event.visitId,
        }
      })
    }

    /**
     * Get the providerId and providerName for an event
     * @param {string} eventId
     * @returns {Promise<{providerId: string, providerName: string} | null>}
     */
    export const getProvider = async (
      eventId: string,
    ): Promise<{ providerId: string; providerName: string } | null> => {
      const event = await database.get<EventModel>("events").find(eventId)
      if (!event) {
        return null
      }
      const { providerId, providerName } = event.metadata
      if (typeof providerId === "string" && typeof providerName === "string") {
        return { providerId, providerName }
      }

      // Events created outside the visit flow carry no provider in metadata.
      const visit = await database.get<VisitModel>("visits").find(event.visitId)
      if (visit) {
        return {
          providerId: visit.providerId,
          providerName: visit.providerName,
        }
      }
      return null
    }

    /**
     * Delete an event by id, along with the problems it put on the patient's
     * chart.
     *
     * @param {string} eventId
     * @returns {Promise<void>}
     */
    export const softDelete = async (eventId: string): Promise<void> => {
      return await database.write(async () => {
        const event = await database.get<EventModel>("events").find(eventId)

        const recorded = await problemsRecordedByEvent(event.patientId, eventId)
        await PatientProblems.DB.softDelete(recorded)

        const deletedEvent = await event.update((event) => {
          event.isDeleted = true
        })
        return await deletedEvent.markAsDeleted()
      })
    }
  }
}

export default Event
