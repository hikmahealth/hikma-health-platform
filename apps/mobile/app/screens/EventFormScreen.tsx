import { FC, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Alert, Pressable, TextStyle, ViewStyle } from "react-native"
import { useCameraPermissions } from "expo-camera"
import * as DocumentPicker from "expo-document-picker"
import * as FileSystem from "expo-file-system/legacy"
import {
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet"
import { CommonActions } from "@react-navigation/native"
import { NativeStackScreenProps } from "@react-navigation/native-stack"
import * as Sentry from "@sentry/react-native"
import { useSelector } from "@xstate/react"
import { isValid } from "date-fns"
import { Option } from "effect"
import { sortBy } from "es-toolkit/compat"
import { LucideAlertCircle, LucideX } from "lucide-react-native"
import { Controller, useForm, useFormState, useWatch } from "react-hook-form"
import DropDownPicker from "react-native-dropdown-picker"
import Toast from "react-native-root-toast"
import { catchError, of as of$ } from "@nozbe/watermelondb/utils/rx"
import { useImmer } from "use-immer"
import { uuidv7 } from "uuidv7"

import Peer from "@/models/Peer"

import { usePermissionGuard } from "@/hooks/usePermissionGuard"
import { Button } from "@/components/Button"
import { CameraCaptureModal } from "@/components/CameraCaptureModal"
import { DatePickerButton } from "@/components/DatePicker"
import { DiagnosisEditor, DiagnosisPickerButton } from "@/components/DiagnosisEditor"
import { If } from "@/components/If"
import { MedicationEditor, MedicationsFormItem } from "@/components/MedicationEditor"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField, $inputWrapperStyle } from "@/components/TextField"
import { Checkbox } from "@/components/Toggle/Checkbox"
import { Radio } from "@/components/Toggle/Radio"
import { View } from "@/components/View"
import database from "@/db"
import EventModel from "@/db/model/Event"
import EventFormModel from "@/db/model/EventForm"
import { useCreateEvent } from "@/hooks/useCreateEvent"
import { useUpdateEvent } from "@/hooks/useUpdateEvent"
import { translate } from "@/i18n/translate"
import Appointment from "@/models/Appointment"
import Event from "@/models/Event"
import EventForm from "@/models/EventForm"
import ICDEntry from "@/models/ICDEntry"
import Prescription from "@/models/Prescription"
import { PatientNavigatorParamList } from "@/navigators/PatientNavigator"
import { useDataAccess } from "@/providers/DataAccessProvider"
import { languageStore } from "@/store/language"
import { providerStore } from "@/store/provider"
import { colors } from "@/theme/colors"
import {
  compileRules,
  computedCount,
  computedEntries,
  computedValuesEqual,
  filterVisibleFields,
  formatComputedValue,
  getComputed,
  hasComputed,
  pruneRulesForLiveFields,
  stabilizeComputedValues,
  summarizeSubmitBlockers,
  type ValidationError,
} from "@/lib/form-rules"
import {
  resolveFormTranslations,
  getOptionId,
  type ResolvedFormTranslations,
} from "@/utils/eventFormTranslations"
import { getProviderAuthHeader, refreshProviderToken } from "@/utils/authHeader"
import { requestWithSessionRetry } from "@/utils/authorizedRequest"
import { sanitizeFieldName, unsanitizeFormData } from "@/utils/fieldNameSanitizer"
import { EVENT_MULTI_SEPARATOR, joinMultiValues } from "@/utils/parsers"
import { useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"
import { Logger } from "@hikmahealth/js-utils"

type ModalState =
  | { activeModal: null }
  | { activeModal: "medication"; medication: Prescription.MedicationEntry }
  | { activeModal: "diagnoses" }

/** Per-field upload state. `files` is the record of what is attached. */
type FileUploadState = {
  isUploading: boolean
  files: Event.Attachment[]
  error: string | null
}

/** A file chosen from the picker or captured by the camera, ready to upload. */
type PickedFile = {
  uri: string
  name: string
  mimeType: string | undefined
  size: number | null
}

// Mirrors the server's allowlist. The server re-checks the leading bytes, so this
// only keeps the picker from offering files that would be rejected on upload.
const FORM_FILE_MIMETYPES = ["image/png", "image/jpeg", "application/pdf"]
const FORM_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024

// expo-camera writes JPEG; takePictureAsync reports neither type nor name.
const CAMERA_CAPTURE_MIMETYPE = "image/jpeg"
const CAMERA_CAPTURE_QUALITY = 0.7

const uploadErrorMessage = (status: number): string => {
  if (status === 401) return "Your session has expired. Please sign in again."
  if (status === 403) return "You do not have permission to upload for this clinic."
  if (status === 409) return "This file could not be attached. Please select it again."
  if (status === 413) return "That file is too large. The maximum size is 50MB."
  if (status === 415) return "That file type is not supported. Use a PNG, JPEG, or PDF."
  return "Failed to upload file. Please try again."
}

const idleFileUploadState: FileUploadState = {
  isUploading: false,
  files: [],
  error: null,
}

/**
 * Name for a camera capture. Generated rather than taken from the device so a
 * filename can never carry patient-identifying information.
 */
const cameraCaptureFileName = (): string =>
  `photo-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`

/**
 * Drop a cached upload copy. Best-effort: failing to delete must never surface
 * as an upload failure, but it must always be attempted — a captured photograph
 * is PHI and nothing else reaps the app cache.
 */
const discardCachedFile = (uri: string): Promise<void> =>
  FileSystem.deleteAsync(uri, { idempotent: true }).catch((error: unknown) => {
    Logger.warn({ msg: "Could not delete cached upload", error })
  })

/**
Hook to manage multiple open pickers by Id
*/
export function useOpenDialogue() {
  const [openId, setOpenId] = useState<null | string>(null)

  const isOpen = useCallback((id: string) => openId === id, [openId])

  const openDialogue = useCallback((id: string) => () => setOpenId(id), [])

  const closeDialogue = useCallback(() => setOpenId(null), [])

  return {
    isOpen,
    openId,
    openDialogue,
    closeDialogue,
  }
}

/**
 * Hook to get the provider for an event
 * @param eventId
 * @returns
 */
export function useEventProvider(
  eventId?: string | null,
): { providerId: string; providerName: string } | null {
  const [provider, setProvider] = useState<{ providerId: string; providerName: string } | null>(
    null,
  )
  useEffect(() => {
    if (eventId) {
      Event.DB.getProvider(eventId).then(setProvider)
    } else {
      setProvider(null)
    }
  }, [eventId])
  return provider
}

interface EventFormScreenProps extends NativeStackScreenProps<
  PatientNavigatorParamList,
  "EventForm"
> {}

export const EventFormScreen: FC<EventFormScreenProps> = ({ navigation, route }) => {
  const {
    patientId,
    formId,
    visitId = null,
    // formData,
    eventId = null,
    visitDate = new Date().getTime(),
    appointmentId = null,
    departmentId = null,
  } = route.params

  const language = useSelector(languageStore, (state) => state.context.language)
  const provider = useSelector(providerStore, (state) => state.context)
  const { isOnline } = useDataAccess()
  const createEventMutation = useCreateEvent()
  const updateEventMutation = useUpdateEvent()
  const { can, checkEditEvent } = usePermissionGuard()

  const { paddingTop: safeAreaPaddingTop } = useSafeAreaInsetsStyle(["top"])

  // get the provider/user who created the form or the event
  const eventProvider = useEventProvider(eventId)
  const { control, handleSubmit, setValue, getValues, watch } = useForm<
    Record<string, string | number | Date | any[]>
  >({
    defaultValues: {},
  })
  // Debug: log all form state changes
  useEffect(() => {
    const subscription = watch((formValues, { name, type }) => {
      Logger.log({ msg: "[FormState change]", changedField: name, type, formValues })
    })
    return () => subscription.unsubscribe()
  }, [watch])

  const [diagnoses, setDiagnoses] = useState<ICDEntry.T[]>([])
  const [medicines, setMedicines] = useState<Prescription.MedicationEntry[]>([])

  // File upload states for each field, keyed by raw field name
  const [fileUploads, setFileUploads] = useState<Record<string, FileUploadState>>({})
  const [captureFieldId, setCaptureFieldId] = useState<string | null>(null)
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()

  const setFileUploadState = useCallback(
    (fieldName: string, update: (prev: FileUploadState) => FileUploadState) =>
      setFileUploads((prev) => ({
        ...prev,
        [fieldName]: update(prev[fieldName] ?? idleFileUploadState),
      })),
    [],
  )

  const {
    form,
    state: formState,
    isLoading,
    eventMissing,
  } = useEventForm(formId, visitId, patientId, eventId)
  const { isOpen, openDialogue, closeDialogue } = useOpenDialogue()

  // Parse-once: compile every rule on the form into a closure when the form
  // (or its field list) loads. Evaluate-per-render: useWatch subscribes to
  // RHF; combined with the side-state below we re-evaluate when anything the
  // rules could read changes.
  const evaluator = useMemo(() => {
    const formFields = form?.formFields ?? []
    // Event-form fields are hard-deleted (absent from the array), so the
    // live set is every present id; this drops rules referencing fields
    // that were removed.
    return compileRules(
      pruneRulesForLiveFields(
        formFields,
        formFields.map((f) => f.id),
      ),
    )
  }, [form?.formFields])
  // useWatch returns `{}`/the form snapshot, but TS types it loosely; the
  // `?? {}` guards the first-render case before any Controller has mounted.
  const watchedValues = (useWatch({ control }) as Record<string, unknown> | undefined) ?? {}
  const ruleStabilization = useMemo(() => {
    if (!form) return null
    const scope = EventForm.buildRuleScope({
      formFields: form.formFields,
      watchedValues,
      diagnoses,
      medicines,
      fileUploads,
      ctx: {
        now: new Date().toISOString(),
        language,
        provider: { id: provider.id, name: provider.name },
      },
    })
    return stabilizeComputedValues({ evaluator, initialScope: scope })
  }, [form, watchedValues, diagnoses, medicines, fileUploads, evaluator, language, provider])
  const ruleEvaluation = ruleStabilization?.evaluation ?? null

  // Pre-bucket validator errors by field id so the renderer doesn't filter
  // the full list per field.
  const errorsByFieldId = useMemo(() => {
    const map = new Map<string, ValidationError[]>()
    if (!ruleEvaluation) return map
    for (const err of ruleEvaluation.validationErrors) {
      const bucket = map.get(err.fieldId)
      if (bucket) bucket.push(err)
      else map.set(err.fieldId, [err])
    }
    return map
  }, [ruleEvaluation])

  // Inline validator errors are gated on touched OR dirty so an editable
  // field that the user hasn't reached yet doesn't show a red error from
  // a rule that fails on `undefined`. Submit consolidation is independent
  // — clicking Save still surfaces everything.
  const { touchedFields, dirtyFields } = useFormState({ control })

  // Dev-only diagnostics. Logger.* is a no-op in production builds.
  useEffect(() => {
    if (!ruleEvaluation || ruleEvaluation.diagnostics.length === 0) return
    Logger.warn({ msg: "[EventForm] rule diagnostics", diagnostics: ruleEvaluation.diagnostics })
  }, [ruleEvaluation])
  useEffect(() => {
    if (!ruleStabilization || ruleStabilization.convergence !== "cycle") return
    // Author-time guardrail in the form-builder catches this before save.
    // If we still see one here, the form shipped a cyclic computedValue
    // chain — suppress writebacks (stabilize already emptied the map)
    // and surface the diagnostic for dev visibility.
    Logger.warn({
      msg: "[EventForm] computedValue cycle detected — writebacks suppressed",
      iterations: ruleStabilization.iterations,
    })
  }, [ruleStabilization])

  // Clear-on-hide writeback: when a field transitions visible→hidden we wipe
  // its value from form state so (a) a stale answer can't sneak into the
  // submit payload, and (b) if the user reshows the field later they see a
  // fresh input rather than the previous answer. We diff against a ref of
  // the prior hidden set so we only act on the *transition* — once a field
  // is cleared and still hidden, the next pass sees no transition and does
  // nothing. That's what keeps the (setValue → useWatch → re-eval → effect)
  // cycle from running unbounded.
  //
  // computedValue writeback: for fields whose `computedValue` rule produced
  // a value this tick, push the value into RHF state. Structural-equality
  // short-circuit prevents the (setValue → useWatch → re-eval → setValue)
  // loop:
  //   - Tick N: rule emits 5, current is undefined → setValue(5)
  //   - Tick N+1: re-eval, rule still emits 5, current is 5 → skip
  //   - No setValue → no re-render → cycle terminates.
  // JSON.stringify equality covers primitives, arrays, dates (as ISO strings
  // via toJSON), and plain objects — the value-shape JSONLogic is capable
  // of producing.
  useEffect(() => {
    if (!form || !ruleEvaluation) return
    if (computedCount(ruleEvaluation) === 0) return
    for (const [fieldId, computed] of computedEntries(ruleEvaluation)) {
      const field = form.formFields.find((f) => f.id === fieldId)
      if (!field) continue
      // computedValue is type-system-gated to input-collecting field
      // variants (binary, free-text, date, options); defensive guard
      // anyway in case misauthored data slips through the type wall.
      if (field.fieldType === "diagnosis" || field.fieldType === "medicine") continue
      if (field.inputType === "file") continue
      const name = sanitizeFieldName(field.name)
      const current = getValues(name)
      if (computedValuesEqual(current, computed)) continue
      setValue(name as never, computed as never)
    }
  }, [ruleEvaluation, form, setValue, getValues])

  // Mirror attached resource ids into RHF so a file field participates in
  // touched/dirty tracking like every other input. Submit reads `fileUploads`,
  // not this — the mirror exists for the form-state machinery only.
  useEffect(() => {
    if (!form) return
    for (const field of form.formFields) {
      if (field.inputType !== "file") continue
      const name = sanitizeFieldName(field.name)
      const ids = (fileUploads[field.name]?.files ?? []).map((file) => file.id)
      if (computedValuesEqual(getValues(name), ids)) continue
      setValue(name as never, ids as never)
    }
  }, [fileUploads, form, setValue, getValues])

  const previouslyHiddenIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!form || !ruleEvaluation) return
    const { nowHidden, newlyHidden } = EventForm.computeNewlyHidden({
      formFields: form.formFields,
      evaluation: ruleEvaluation,
      previouslyHidden: previouslyHiddenIds.current,
    })
    // Early-return guards against `useWatch` reference churn — if no field
    // just hid, there is nothing to clear and no setter to call.
    if (newlyHidden.length > 0) {
      for (const field of newlyHidden) {
        // NOTE: diagnoses / medicines are form-scope state shared across
        // all fields of that type. A form only ever has one diagnosis and
        // one medicine field in practice; hiding either resets the whole
        // shared collection, which matches user intent.
        if (field.fieldType === "diagnosis") {
          setDiagnoses([])
        } else if (field.fieldType === "medicine") {
          setMedicines([])
        } else if (field.inputType === "file") {
          setFileUploads((prev) => {
            if (!(field.name in prev)) return prev
            const next = { ...prev }
            delete next[field.name]
            return next
          })
        } else {
          setValue(sanitizeFieldName(field.name) as never, undefined as never)
        }
      }
    }
    previouslyHiddenIds.current = nowHidden
  }, [ruleEvaluation, form, setValue])

  const bottomSheetModalRef = useRef<BottomSheetModal>(null)

  const snapPoints = useMemo(() => ["90%", "90%"], [])

  const [modalState, updateModalState] = useImmer<ModalState>({
    activeModal: null,
  })

  // callbacks
  // const handlePresentModalPress = useCallback(() => {
  // bottomSheetModalRef.current?.present()
  // }, [])
  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        updateModalState((draft) => {
          draft.activeModal = null
        })
      }
    },
    [updateModalState],
  )

  const openMedicationEditor = useCallback(
    (medication?: Prescription.MedicationEntry) => {
      updateModalState((draft) => {
        draft.activeModal = "medication"
        if (draft.activeModal === "medication" && medication) {
          draft.medication = medication
        }
      })
      bottomSheetModalRef.current?.present()
    },
    [updateModalState],
  )

  const openDiagnosesEditor = useCallback(() => {
    updateModalState((draft) => {
      draft.activeModal = "diagnoses"
    })
    bottomSheetModalRef.current?.present()
  }, [updateModalState])

  const updateDiagnoses = useCallback(
    (diagnoses: ICDEntry.T[]) => {
      setDiagnoses(diagnoses)
      updateModalState((draft) => {
        draft.activeModal = null
      })
      bottomSheetModalRef.current?.dismiss()
    },
    [updateModalState],
  )

  useEffect(() => {
    if (form && formState) {
      formState.formData.map((field) => {
        if (field.fieldType === "diagnosis") {
          const diagnosisValue = Array.isArray(field?.value) ? field.value : []
          setDiagnoses(diagnosisValue as ICDEntry.T[])
        } else if (field.fieldType === "medicine") {
          const medicineValue = Array.isArray(field?.value) ? field.value : []
          setMedicines(medicineValue as Prescription.MedicationEntry[])
        } else if (field.inputType === "file") {
          // Submit writes whatever `fileUploads` holds, so an unseeded file
          // field would save an empty id list and unlink the patient's
          // attachments.
          const files = Event.readAttachments(field)
          setFileUploadState(field.name, () => ({ ...idleFileUploadState, files }))
        }
        setValue(sanitizeFieldName(field.name), field.value)
      })
    }
  }, [formState, form, setFileUploadState])

  const [loading, setLoading] = useState(false)

  // New event creation is always allowed; editing respects isEditable
  const isEditing = eventId !== null
  const canSaveForm = useMemo(() => {
    if (!form || loading) return false
    if (isEditing && form.isEditable === false) return false
    return true
  }, [form, loading, isEditing])

  // Show a toast when trying to edit a non-editable form
  useEffect(() => {
    if (isEditing && form && form.isEditable === false) {
      Toast.show("Form is not editable", {
        duration: Toast.durations.SHORT,
        position: Toast.positions.BOTTOM,
        shadow: true,
        animation: true,
        hideOnPress: true,
        delay: 0,
      })
    }
  }, [isEditing, form?.isEditable])

  const onSubmit = async (rawData: Record<string, any>) => {
    const data = unsanitizeFormData(rawData)
    Logger.log({ msg: "onSubmit", data })
    if (loading) {
      return
    }

    // Permission check: editing an existing event vs creating a new one
    if (isEditing && eventProvider) {
      const editResult = checkEditEvent(eventProvider.providerId)
      if (!editResult.ok) {
        Toast.show(editResult.error.message, {
          duration: Toast.durations.SHORT,
          position: Toast.positions.BOTTOM,
        })
        return
      }
    } else if (!isEditing && !can("event:create")) {
      Toast.show("You do not have permission to create events", {
        duration: Toast.durations.SHORT,
        position: Toast.positions.BOTTOM,
      })
      return
    }

    // Validate required fields + validator rules before submission. Both
    // classes of error are surfaced in a single toast so the user sees one
    // coherent message instead of two competing ones. Dedup of identical
    // validator messages lives in `summarizeSubmitBlockers`.
    if (form) {
      const gate = summarizeSubmitBlockers({
        missingFieldNames: EventForm.getMissingRequiredFields({
          formFields: form.formFields,
          data,
          diagnoses,
          medicines,
          fileUploads,
          evaluation: ruleEvaluation ?? undefined,
        }),
        validatorErrors: ruleEvaluation?.validationErrors ?? [],
      })

      if (gate.blocked) {
        const parts: string[] = []
        if (gate.missingRequired.length > 0) {
          parts.push(`missing required fields: ${gate.missingRequired.join(", ")}`)
        }
        if (gate.validatorErrors.length > 0) {
          parts.push(gate.validatorErrors.map((e) => e.message).join("; "))
        }
        const msg = `Please fix: ${parts.join(" — ")}`
        Logger.log({
          msg: "[EventForm] submission blocked",
          missingFields: gate.missingRequired,
          validatorErrors: gate.validatorErrors,
          data,
        })
        Toast.show(msg, {
          duration: Toast.durations.LONG,
          position: Toast.positions.BOTTOM,
          shadow: true,
          animation: true,
          hideOnPress: true,
          delay: 0,
        })
        return
      }
    }

    setLoading(true)

    // Defense-in-depth: filter hidden fields out of the outbound payload.
    // The clear-on-hide effect already wiped their values, but there's a
    // one-tick race if the user clicks Save in the same frame a field hides
    // (effects run after paint, submit handlers don't). Belt and suspenders.
    const visibleFields = filterVisibleFields(
      (form?.formFields ?? []).filter((f) => !EventForm.isDisplayOnly(f)),
      ruleEvaluation,
    )
    const formData = visibleFields
      .map((field) => {
        if (field.inputType !== "file") {
          return {
            fieldId: field.id,
            fieldType: field.fieldType,
            value: data[field.name] || "",
            inputType: field.inputType,
            name: field.name,
          }
        }
        // `value` holds the resource ids and is the sole authz key; the
        // parallel `attachments` records are display metadata, keyed by id so
        // they cannot drift out of alignment with it.
        const files = fileUploads[field.name]?.files ?? []
        return {
          fieldId: field.id,
          fieldType: field.fieldType,
          value: files.map((file) => file.id),
          inputType: field.inputType,
          name: field.name,
          attachments: files,
        }
      })
      .filter(
        (field) =>
          field.name.toLowerCase() !== "diagnosis" &&
          field.name.toLowerCase() !== "medications" &&
          field.fieldType.toLowerCase() !== "diagnosis" &&
          field.name.toLowerCase() !== "medicine" &&
          field.fieldType.toLowerCase() !== "medicine",
      )

    // if the form has medicine and diagnosis fields, add them to the form data.
    // Visibility re-check here covers the per-field tail-append path.
    const isFieldVisible = (field: { id: string }): boolean =>
      ruleEvaluation ? ruleEvaluation.isVisible(field.id) : true
    const medicineField = form?.formFields.find((field) => field.fieldType === "medicine")
    const diagnosisField = form?.formFields.find((field) => field.fieldType === "diagnosis")
    if (medicineField && isFieldVisible(medicineField)) {
      // add the medications state array to the form data
      formData.push({
        fieldId: medicineField.id,
        value: medicines,
        fieldType: medicineField.fieldType,
        inputType: "input-group",
        name: medicineField.name,
      })
    }
    if (diagnosisField && isFieldVisible(diagnosisField)) {
      // add the diagnoses state array to the form data
      formData.push({
        fieldId: diagnosisField.id,
        value: diagnoses,
        fieldType: diagnosisField.fieldType,
        inputType: "input-group",
        name: diagnosisField.name,
      })
    }

    const newEvent: EventModel = {
      formId,
      visitId: visitId || "",
      eventType: form?.name || "",
      patientId,
      formData,
    }

    try {
      let resVisitId: string | null = visitId

      if (isOnline) {
        // Online path: use DataProvider mutation
        if (eventId) {
          await updateEventMutation.mutateAsync({
            id: eventId,
            data: { formData: formData as any, metadata: {} },
          })
        } else {
          const res = await createEventMutation.mutateAsync({
            patientId,
            visitId,
            eventType: form?.name || "",
            formId,
            formData: formData as any,
            clinicId: Option.getOrUndefined(provider.clinic_id),
            providerId: provider.id,
            providerName: provider.name,
            checkInTimestamp: visitDate,
            recordedByUserId: provider.id,
          })
          resVisitId = res.visitId
        }
      } else {
        // Offline path: existing WatermelonDB writes
        const res = await Event.DB.create(
          newEvent,
          visitId,
          Option.getOrUndefined(provider.clinic_id) || "",
          provider.id,
          provider.name,
          visitDate,
          eventId,
        )
        resVisitId = res.visitId
      }

      // Update the appointment with the visitId (shared by both paths)
      if (appointmentId) {
        if (departmentId) {
          Appointment.DB.updateAppointmentDepartmentStatus(
            appointmentId,
            departmentId,
            provider.id,
            "completed",
          ).catch((e) => {
            Logger.error({ msg: "Error updating appointment department status", e })
            Sentry.captureException(e)
          })
        }
        Appointment.DB.markComplete(appointmentId, provider.id, resVisitId ?? "", {
          preserveStatus: departmentId ? true : false,
        }).catch((e) => {
          Logger.error({ msg: "Error updating appointment with visitId", e })
          Sentry.captureException(e)
        })
      }

      if (visitId) {
        navigation.goBack()
      } else {
        navigation.popTo("NewVisit", { patientId, visitDate, visitId: resVisitId })
      }
    } catch (e) {
      Logger.error(e)
      Alert.alert("Error connecting to the database")
      Sentry.captureException(e, {
        level: "error",
        extra: {
          formId,
          visitId,
          patientId,
          eventId,
        },
      })
    } finally {
      setLoading(false)
    }
  }

  // Resolve translations for the form fields based on the user's language
  const resolved = useMemo<ResolvedFormTranslations | null>(() => {
    if (!form) return null
    return resolveFormTranslations(form, language)
  }, [form, language])

  /** Get the translated or original description for a field, or undefined if empty */
  const getFieldDescription = useCallback(
    (field: EventForm.FieldItem): string | undefined => {
      const desc = resolved?.fieldDescriptions[field.id] || field.description
      return desc || undefined
    },
    [resolved],
  )

  // Helper to get translated items for select/dropdown fields, preserving original values
  const getTranslatedItems = useCallback(
    (field: EventForm.FieldItem) => {
      const items = Option.isOption(field.options)
        ? Option.getOrElse(field.options, () => [])
        : field.options || []
      if (!resolved?.optionLabels[field.id]) return items
      return items.map((option: any) => {
        if (typeof option === "string") return option
        const key = getOptionId(option)
        const translatedLabel = resolved.optionLabels[field.id]?.[key]
        return translatedLabel ? { ...option, label: translatedLabel } : option
      })
    },
    [resolved],
  )

  // set the title of the page
  useEffect(() => {
    navigation.setOptions({
      title: resolved?.formName ?? form?.name ?? "Event Form",
    })
  }, [resolved?.formName, form?.name, navigation])

  const updateMedication = useCallback(
    (medication: Prescription.MedicationEntry) => {
      // set the medication in the form
      // setValue("medicine" as never, medication)
      // the form has a medicine field that is an array of medications, so we need to get the current value of the field and add the new medication to it if the current array does not have the same medication id
      const currentMedications = medicines
      const medicationExists = currentMedications.find(
        (m: Prescription.MedicationEntry) => m.id === medication.id,
      )
      if (!medicationExists) {
        setMedicines((meds) => [...meds, medication])
      } else {
        setMedicines((meds) => meds.map((m) => (m.id === medication.id ? medication : m)))
      }
      updateModalState((draft) => {
        draft.activeModal = null
      })
      bottomSheetModalRef.current?.dismiss()
    },
    [medicines, updateModalState],
  )

  const medicineOptions = useMemo(() => {
    const res = form?.formFields.find((field) => field.fieldType === "medicine")?.options || []

    if (Option.isOption(res)) {
      return Option.getOrElse(res, () => [])
    }
    return []
  }, [form?.formFields])

  const captureField = useMemo(
    () => form?.formFields.find((field) => field.id === captureFieldId) ?? null,
    [form?.formFields, captureFieldId],
  )

  /** How many more files this field will accept. */
  const remainingFileSlots = (field: EventForm.FieldItem): number => {
    const { maxItems } = EventForm.fileFieldLimits(field)
    return Math.max(0, maxItems - (fileUploads[field.name]?.files.length ?? 0))
  }

  /**
   * Upload one file and return its resource record. The id is generated on the
   * device so a retry carrying identical bytes resolves to the same resource
   * rather than creating a duplicate.
   *
   * Filenames are not logged: they can carry patient-identifying information.
   */
  const uploadFormFile = async (
    field: { id: string },
    file: PickedFile,
  ): Promise<Event.Attachment> => {
    if (file.size !== null && file.size > FORM_FILE_SIZE_LIMIT_BYTES) {
      throw new Error(uploadErrorMessage(413))
    }

    const clinicId = Option.getOrNull(provider.clinic_id)
    if (!clinicId) throw new Error("No clinic is assigned to this account.")

    const authorization = await getProviderAuthHeader()
    if (!authorization) throw new Error("Not signed in. Please sign in again.")

    // Not `getActiveUrl`: it prefers the hub, which serves no `/api` routes.
    const apiUrl = await Peer.getCloudApiUrl()
    if (!apiUrl) {
      throw new Error("Uploads need a cloud server, and none is configured on this device.")
    }

    const resourceId = uuidv7()

    try {
      // Not fetch + FormData: Expo replaces the global fetch, and its FormData
      // serializer rejects React Native's `{ uri, name, type }` file part with
      // "Unsupported FormDataPart implementation". uploadAsync also streams from
      // disk instead of buffering up to 50MB into JS memory.
      // `resourceId` is fixed outside the retry, so a replay resolves to the
      // same resource rather than attaching the file twice.
      const uploaded = await requestWithSessionRetry({
        authorization,
        refresh: () => refreshProviderToken(apiUrl),
        attempt: (auth) =>
          FileSystem.uploadAsync(`${apiUrl}/api/forms/resources`, file.uri, {
            httpMethod: "POST",
            uploadType: FileSystem.FileSystemUploadType.MULTIPART,
            fieldName: "file",
            mimeType: file.mimeType,
            parameters: {
              id: resourceId,
              patient_id: patientId,
              clinic_id: clinicId,
              field_id: field.id,
            },
            headers: { Authorization: auth },
          }),
      })

      if (uploaded.status < 200 || uploaded.status >= 300) {
        throw new Error(uploadErrorMessage(uploaded.status))
      }

      const { id, mimetype } = JSON.parse(uploaded.body) as {
        id: string
        mimetype: string | null
      }

      return { id, fileName: file.name, mimetype: mimetype ?? null }
    } finally {
      // Runs on failure too: a captured photograph is PHI and nothing retries
      // from this uri, so the cache copy is dead either way.
      await discardCachedFile(file.uri)
    }
  }

  /**
   * Upload files one at a time, appending each success to the field.
   *
   * Sequential rather than concurrent: on a weak clinic connection a partial
   * failure then leaves the already-uploaded files attached and the error names
   * the file that failed, instead of an ambiguous half-finished batch.
   */
  const uploadFilesToField = async (field: EventForm.FieldItem, files: PickedFile[]) => {
    // Capacity is enforced here rather than at each call site so no caller can
    // push a field past `maxItems`, however it acquired the files.
    const admitted = files.slice(0, remainingFileSlots(field))
    if (admitted.length === 0) return
    const fieldName = field.name

    setFileUploadState(fieldName, (prev) => ({ ...prev, isUploading: true, error: null }))
    try {
      for (const file of admitted) {
        const attachment = await uploadFormFile(field, file)
        setFileUploadState(fieldName, (prev) => ({
          ...prev,
          files: [...prev.files, attachment],
        }))
      }
      setFileUploadState(fieldName, (prev) => ({ ...prev, isUploading: false }))
    } catch (error: unknown) {
      Logger.error({ msg: "File upload failed", error })
      Sentry.captureException(error)

      const message = error instanceof Error ? error.message : "Failed to upload file"
      setFileUploadState(fieldName, (prev) => ({ ...prev, isUploading: false, error: message }))
      Alert.alert("Upload Error", message)
    }
  }

  /**
   * Detach a file from the field. The uploaded resource is left on the server;
   * nothing references it, and reaping orphans is the server's job.
   */
  const removeAttachedFile = (fieldName: string, attachmentId: string) =>
    setFileUploadState(fieldName, (prev) => ({
      ...prev,
      error: null,
      files: prev.files.filter((file) => file.id !== attachmentId),
    }))

  const handleChooseFile = async (field: EventForm.FieldItem) => {
    const remaining = remainingFileSlots(field)
    if (remaining <= 0) return

    let picked: DocumentPicker.DocumentPickerResult
    try {
      picked = await DocumentPicker.getDocumentAsync({
        type: FORM_FILE_MIMETYPES,
        copyToCacheDirectory: true,
        multiple: remaining > 1,
      })
    } catch (error: unknown) {
      // A picker that fails to open must say so; silently doing nothing reads
      // as an unresponsive button.
      Logger.error({ msg: "File picker failed", error })
      Sentry.captureException(error)
      Alert.alert("Upload Error", "Could not open the file picker. Please try again.")
      return
    }
    if (picked.canceled) return

    if (picked.assets.length > remaining) {
      Toast.show(`Only ${remaining} more file(s) can be attached here.`, {
        duration: Toast.durations.SHORT,
        position: Toast.positions.BOTTOM,
      })
    }

    await uploadFilesToField(
      field,
      picked.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
        size: typeof asset.size === "number" ? asset.size : null,
      })),
    )
  }

  const handleTakePhoto = async (field: EventForm.FieldItem) => {
    if (remainingFileSlots(field) <= 0) return

    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission()
    if (!permission?.granted) {
      Alert.alert("Camera", "Camera permission is required to take a photo.")
      return
    }

    setCaptureFieldId(field.id)
  }

  const handlePhotoCaptured = async (uri: string) => {
    const field = captureField
    setCaptureFieldId(null)
    if (!field) {
      // Nothing will upload this capture, so it must not linger in the cache.
      await discardCachedFile(uri)
      return
    }

    // An unreadable capture still uploads: the server re-checks size and type,
    // so a missing local size only skips the early client-side rejection.
    const size = await FileSystem.getInfoAsync(uri)
      .then((info) => (info.exists && typeof info.size === "number" ? info.size : null))
      .catch(() => null)

    await uploadFilesToField(field, [
      {
        uri,
        name: cameraCaptureFileName(),
        mimeType: CAMERA_CAPTURE_MIMETYPE,
        size,
      },
    ])
  }

  if (isLoading) return <Text>Loading...</Text>
  if (!form) {
    return (
      <View alignItems="center" pt={40} justifyContent="center">
        <LucideAlertCircle size={60} color={colors.textDim} />
        <Text size="lg">Form does not exist. </Text>
      </View>
    )
  }
  if (eventMissing) {
    return (
      <View alignItems="center" pt={40} justifyContent="center" px={24}>
        <LucideAlertCircle size={60} color={colors.textDim} />
        <Text size="lg">This entry is not available on this device.</Text>
        <Text size="sm" style={{ textAlign: "center" }}>
          It may have been deleted, or it may not have synced yet.
        </Text>
      </View>
    )
  }

  return (
    <BottomSheetModalProvider>
      <Screen style={$root} preset="scroll">
        <View gap={12} pb={24}>
          {form.formFields.map((field) => {
            // Visibility gate. Hiding via early-return rather than a wrapper
            // keeps the existing branch tree untouched. NOTE: the key on this
            // <View> was previously index-based; switched to field.id so that
            // visibility toggles don't shift indices and re-mount every
            // Controller after the toggled field (which would reset values).
            if (ruleEvaluation && !ruleEvaluation.isVisible(field.id)) return null
            const fieldErrors = errorsByFieldId.get(field.id)
            // Editable inputs hide inline errors until the user has touched
            // or modified the field; read-only computed fields always show
            // them (the user can't touch them, so the only way to learn
            // about a blocking validator is to see the message). The
            // submit-time consolidated toast surfaces everything either way.
            const fieldName = sanitizeFieldName(field.name)
            const fieldInteracted = Boolean(
              touchedFields[fieldName] || dirtyFields[fieldName],
            )

            // A field with a successful computedValue rule renders as a
            // read-only labelled display of the computed value (skipping the
            // editable Controller branches). The writeback effect keeps RHF
            // state in sync with the computation; submit reads from RHF as
            // usual.
            if (ruleEvaluation && hasComputed(ruleEvaluation, field.id)) {
              const computed = getComputed(ruleEvaluation, field.id)
              return (
                <View key={field.id}>
                  <Text
                    text={resolved?.fieldNames[field.id] ?? field.name}
                    preset="formLabel"
                  />
                  <Text text={formatComputedValue(computed)} />
                  {fieldErrors && fieldErrors.length > 0 ? (
                    <View pt={4}>
                      {fieldErrors.map((err) => (
                        <Text
                          key={err.validatorId}
                          text={err.message}
                          color={colors.error}
                        />
                      ))}
                    </View>
                  ) : null}
                </View>
              )
            }

            return (
              <View key={field.id}>
                {/* Static text display (read-only) */}
                <If condition={field.fieldType === "text"}>
                  <Text
                    text={resolved?.fieldNames[field.id] ?? field.content ?? field.name}
                    size={field.size ?? "md"}
                  />
                  {getFieldDescription(field) ? (
                    <Text text={getFieldDescription(field)} size="xs" color={colors.textDim} />
                  ) : null}
                </If>

                {/* Visual separator / divider */}
                <If condition={field.fieldType === "separator"}>
                  <View py={8}>
                    <View style={$separator} />
                  </View>
                </If>

                <If
                  condition={
                    (field.inputType === "text" || field.inputType === "number") &&
                    field.fieldType !== "text" &&
                    field.fieldType !== "separator"
                  }
                >
                  <Controller
                    render={({ field: { onChange, onBlur, value } }) => (
                      <TextField
                        label={resolved?.fieldNames[field.id] ?? field.name}
                        description={getFieldDescription(field)}
                        onChangeText={onChange}
                        keyboardType={field.inputType === "number" ? "number-pad" : "default"}
                        onBlur={onBlur}
                        required={field.required}
                        value={value}
                      />
                    )}
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                  />
                </If>
                <If condition={field.inputType === "textarea"}>
                  <Controller
                    render={({ field: { onChange, onBlur, value } }) => (
                      <TextField
                        label={resolved?.fieldNames[field.id] ?? field.name}
                        description={getFieldDescription(field)}
                        onChangeText={onChange}
                        onBlur={onBlur}
                        required={field.required}
                        value={value}
                        multiline
                      />
                    )}
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                  />
                </If>

                <If condition={field.inputType === "select" && field.fieldType !== "diagnosis"}>
                  <Controller
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                    render={({ field: { value, onChange } }) => {
                      const isMulti = Option.isOption(field.multi)
                        ? Option.getOrElse(field.multi, () => false)
                        : field.multi || false
                      const label = resolved?.fieldNames[field.id] ?? field.name
                      return (
                        <View style={{}}>
                          <View
                            direction="row"
                            alignItems="center"
                            justifyContent="space-between"
                            gap={8}
                          >
                            <Text text={label} preset="formLabel" withAsterisk={field.required} />
                            {hasSelectValue(value) ? (
                              <Pressable
                                onPress={() => onChange("")}
                                hitSlop={12}
                                accessibilityRole="button"
                                accessibilityLabel={`Clear ${label}`}
                              >
                                <Text text="Clear" size="xs" color={colors.palette.primary500} />
                              </Pressable>
                            ) : null}
                          </View>
                          {getFieldDescription(field) ? (
                            <Text
                              text={getFieldDescription(field)}
                              size="xs"
                              color={colors.textDim}
                            />
                          ) : null}
                          <DropDownPicker
                            open={isOpen(field.id)}
                            value={multiPickerValue(value, isMulti)}
                            searchable
                            closeAfterSelecting
                            style={$dropDownStyle}
                            modalTitle={label}
                            multiple={isMulti}
                            modalContentContainerStyle={[
                              $modalContentContainerStyle,
                              { paddingTop: safeAreaPaddingTop },
                            ]}
                            mode="BADGE"
                            searchPlaceholder={
                              translate("common:search", { defaultValue: "Search" }) + "..."
                            }
                            searchTextInputStyle={$inputWrapperStyle as unknown as TextStyle}
                            closeOnBackPressed
                            onClose={closeDialogue}
                            items={sortBy(getTranslatedItems(field), ["label"])}
                            setOpen={openDialogue(field.id)}
                            listMode="MODAL"
                            setValue={(callback) => {
                              const pickerValue = multiPickerValue(
                                getValues(sanitizeFieldName(field.name)) as any,
                                Option.getOrElse(field.multi, () => false),
                              )
                              const data = callback(pickerValue || "")
                              const newValue =
                                field.multi && Array.isArray(data) ? joinMultiValues(data) : data
                              setValue(sanitizeFieldName(field.name) as never, newValue as never)
                            }}
                          />
                        </View>
                      )
                    }}
                  />
                </If>

                <If condition={field.inputType === "checkbox"}>
                  <Controller
                    render={({ field: { value } }) => (
                      <View gap={4}>
                        <View mt={4} />
                        <Checkbox
                          label={resolved?.fieldNames[field.id] ?? field.name}
                          value={value}
                          onValueChange={(value) => {
                            if (value) {
                              setValue(sanitizeFieldName(field.name) as never, value as never)
                            } else {
                              setValue(sanitizeFieldName(field.name) as never, "" as never)
                            }
                          }}
                        />
                        {getFieldDescription(field) ? (
                          <Text
                            text={getFieldDescription(field)}
                            size="xs"
                            color={colors.textDim}
                          />
                        ) : null}
                      </View>
                    )}
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                  />
                </If>

                <If condition={field.inputType === "file"}>
                  <Controller
                    render={() => {
                      const upload = fileUploads[field.name]
                      const attachedFiles = upload?.files ?? []
                      const isAtCapacity = remainingFileSlots(field) <= 0
                      return (
                        <View gap={4}>
                          <Text
                            text={resolved?.fieldNames[field.id] ?? field.name}
                            preset="formLabel"
                            withAsterisk={field.required}
                          />
                          {getFieldDescription(field) ? (
                            <Text
                              text={getFieldDescription(field)}
                              size="xs"
                              color={colors.textDim}
                            />
                          ) : null}
                          <View gap={4}>
                            {attachedFiles.map((file) => (
                              <View
                                key={file.id}
                                direction="row"
                                alignItems="center"
                                justifyContent="space-between"
                                gap={8}
                              >
                                <Text text={file.fileName || "File uploaded"} />
                                <Pressable
                                  onPress={() => removeAttachedFile(field.name, file.id)}
                                  hitSlop={12}
                                  accessibilityLabel={`Remove ${file.fileName || "file"}`}
                                >
                                  <LucideX size={18} color={colors.textDim} />
                                </Pressable>
                              </View>
                            ))}
                            {upload?.isUploading ? (
                              <View
                                direction="row"
                                alignItems="center"
                                gap={8}
                                style={$inputWrapperStyle as unknown as ViewStyle}
                              >
                                <ActivityIndicator
                                  size="small"
                                  color={colors.palette.primary400}
                                />
                                <Text text="Uploading..." />
                              </View>
                            ) : (
                              <View direction="row" gap={8}>
                                <Button
                                  text="Take Photo"
                                  preset="default"
                                  disabled={isAtCapacity}
                                  style={$fileButtonStyle}
                                  onPress={() => handleTakePhoto(field)}
                                />
                                <Button
                                  text="Choose File"
                                  preset="default"
                                  disabled={isAtCapacity}
                                  style={$fileButtonStyle}
                                  onPress={() => handleChooseFile(field)}
                                />
                              </View>
                            )}
                            {upload?.error && (
                              <Text text={upload.error} color={colors.error} />
                            )}
                          </View>
                        </View>
                      )
                    }}
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                  />
                </If>

                <If condition={field.inputType === "date"}>
                  <Controller
                    render={({ field: { onChange, value } }) => (
                      <View style={{}}>
                        <Text
                          text={resolved?.fieldNames[field.id] ?? field.name}
                          preset="formLabel"
                          withAsterisk={field.required}
                        />
                        {getFieldDescription(field) ? (
                          <Text
                            text={getFieldDescription(field)}
                            size="xs"
                            color={colors.textDim}
                          />
                        ) : null}
                        <View>
                          <DatePickerButton
                            date={isValid(new Date(value)) ? new Date(value) : new Date()}
                            mode="date"
                            theme="light"
                            onDateChange={onChange}
                          />
                        </View>
                      </View>
                    )}
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                  />
                </If>

                <If condition={field.inputType === "radio"}>
                  <Controller
                    render={({ field: { value } }) => (
                      <View gap={4}>
                        <Text
                          text={resolved?.fieldNames[field.id] ?? field.name}
                          preset="formLabel"
                          withAsterisk={field.required}
                        />
                        {getFieldDescription(field) ? (
                          <Text
                            text={getFieldDescription(field)}
                            size="xs"
                            color={colors.textDim}
                          />
                        ) : null}
                        <View mt={4} />
                        {getTranslatedItems(field).map((option: any) => (
                          <Radio
                            key={option.value}
                            label={option.label}
                            value={value === option.value}
                            onValueChange={(value) => {
                              if (value) {
                                setValue(
                                  sanitizeFieldName(field.name) as never,
                                  option.value as never,
                                )
                              } else {
                                // set the default value to an empty string
                                setValue(sanitizeFieldName(field.name) as never, "" as never)
                              }
                            }}
                          />
                        ))}
                      </View>
                    )}
                    name={sanitizeFieldName(field.name) as never}
                    control={control}
                  />
                </If>

                <If condition={field.inputType === "input-group" && field.fieldType === "medicine"}>
                  <MedicationsFormItem
                    openMedicationEditor={openMedicationEditor}
                    deleteEntry={(med) => {
                      setMedicines((meds) => meds.filter((m) => m.id !== med))
                    }}
                    value={medicines}
                    onEditEntry={(med) => openMedicationEditor(med)}
                    viewOnly={false}
                  />
                </If>

                <If condition={field.fieldType === "diagnosis"}>
                  <DiagnosisPickerButton
                    language={language}
                    openDiagnosisPicker={openDiagnosesEditor}
                    key={field.id}
                    required={field.required}
                    value={diagnoses || []}
                  />
                </If>

                {/* Validator errors. Rendered at the end of the field block so
                    every input variant gets them without modifying its branch.
                    Gated on touched/dirty to avoid eager errors on untouched
                    fields whose rule can't evaluate against `undefined`. */}
                {fieldInteracted && fieldErrors && fieldErrors.length > 0 ? (
                  <View gap={2} mt={4}>
                    {fieldErrors.map((err) => (
                      <Text
                        key={err.validatorId}
                        text={err.message}
                        size="xs"
                        color={colors.error}
                      />
                    ))}
                  </View>
                ) : null}
              </View>
            )
          })}

          {/* Information about the user who filled out the form or the user who created the event in the first place as a fallback */}
          <If condition={eventProvider !== null}>
            <View gap={4} py={6} direction="row">
              <Text text="Created by:" />
              <Text text={eventProvider?.providerName} />
            </View>
          </If>

          <Button
            preset="default"
            disabled={!canSaveForm}
            onPress={handleSubmit(onSubmit)}
            testID="submit"
          >
            {loading ? translate("common:loading") : translate("common:save")}
          </Button>
        </View>
      </Screen>

      <BottomSheetModal
        ref={bottomSheetModalRef}
        index={1}
        snapPoints={snapPoints}
        onChange={handleSheetChanges}
      >
        <BottomSheetScrollView style={{}}>
          <If condition={modalState.activeModal === "medication"}>
            <MedicationEditor
              medication={
                modalState.activeModal === "medication"
                  ? ((modalState as any).medication as Prescription.MedicationEntry)
                  : undefined
              }
              medicineOptions={medicineOptions}
              onSubmit={updateMedication}
            />
          </If>
          <If condition={modalState.activeModal === "diagnoses"}>
            <DiagnosisEditor language={language} onSubmit={updateDiagnoses} diagnoses={diagnoses} />
          </If>
        </BottomSheetScrollView>
      </BottomSheetModal>

      <CameraCaptureModal
        visible={captureField !== null}
        label={captureField ? (resolved?.fieldNames[captureField.id] ?? captureField.name) : undefined}
        quality={CAMERA_CAPTURE_QUALITY}
        onCapture={handlePhotoCaptured}
        onClose={() => setCaptureFieldId(null)}
      />
    </BottomSheetModalProvider>
  )
}

// TODO: Add support for the following
// - [ ] Date input
// - [ ] Diagnosis input
// - [ ] Medication input
// - [ ] Update radio & checkbox options
// - [ ] Support for editing an existing event

type EventFormState = {
  form: EventFormModel | null
  // fields: EventFormModel["formFields"]
  // setFieldValue: (fieldId: string, value: any) => void
  // getFieldValue: (fieldId: string) => any
  state: EventModel | null
  isLoading: boolean
  /** An `eventId` was given to edit, but no such event exists on this device. */
  eventMissing: boolean
}

// FIXME: MUST REFACTOR & remove all unused code
/**
 * Hook to manage and update an event form
 * TODO: add support for editing an existing event form
 *
 * @param formId - The form ID
 * @param visitId - The visit ID
 * @param patientId - The patient ID
 * @param eventId - If this is an existing event, the event ID to edit or null if this is a new event
 */
function useEventForm(
  formId: string,
  visitId: string | null,
  patientId: string,
  eventId: string | null,
): EventFormState {
  const [form, setForm] = useState<EventFormModel | null>(null)
  const [formState, updateFormState] = useImmer<EventModel | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [eventMissing, setEventMissing] = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    let formSub: { unsubscribe: () => void } | null = null
    let formReady = false
    let eventReady = !eventId // no event to load = already ready

    setEventMissing(false)

    const checkReady = () => {
      if (!cancelled && formReady && eventReady) {
        setIsLoading(false)
      }
    }

    /** Subscribe to the form */
    database.collections
      .get<EventFormModel>("event_forms")
      .find(formId)
      .then((record) => {
        if (cancelled) return
        formSub = record.observe().subscribe((form) => {
          if (!cancelled) {
            setForm(form)
            formReady = true
            checkReady()
          }
        })
      })
      .catch((error) => {
        Logger.error(error)
        if (!cancelled) {
          setForm(null)
          formReady = true
          checkReady()
        }
      })

    /** Subscribe to the event if it exists */
    const eventSub = eventId
      ? database.collections
          .get<EventModel>("events")
          .findAndObserve(eventId)
          .pipe(
            // Absent on this device — deleted upstream or never synced; unpiped it crashes the app.
            catchError((error) => {
              Logger.error(error)
              return of$(null)
            }),
          )
          .subscribe((event) => {
            if (cancelled) return
            // Never a blank draft: isEditing stays true, so saving would blank the unsynced record.
            if (!event) {
              setEventMissing(true)
              eventReady = true
              checkReady()
              return
            }
            updateFormState((d) => {
              const draft = d || ({} as any)
              draft.formId = event.formId
              draft.visitId = event.visitId
              draft.patientId = event.patientId
              draft.formData = event.formData
              draft.createdAt = event.createdAt
              draft.updatedAt = event.updatedAt
              draft.id = event.id
              return draft
            })
            eventReady = true
            checkReady()
          })
      : null

    return () => {
      cancelled = true
      formSub?.unsubscribe()
      eventSub?.unsubscribe()
      setIsLoading(true)
      setForm(null)
    }
  }, [formId, eventId])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getFieldValue = useCallback(
    (fieldId: string) => {
      return formState?.formData.find((field) => field.fieldId === fieldId)?.value
    },
    [formState?.formData],
  )

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const setFieldValue = useCallback((fieldId: string, value: any) => {
    updateFormState((draft) => {
      if (draft) {
        const field = draft.formData.find((field) => field.fieldId === fieldId)
        if (field) {
          field.value = value
        }
      }
    })
  }, [])

  return {
    form: form,
    isLoading,
    eventMissing,
    // fields: form?.formFields ?? [],
    state: formState,
    // getFieldValue: getFieldValue,
    // setFieldValue,
  }
}

/**
Given a form value and whether or not it supports multiple inputs, return the properly formatted value for the dropdown picker
*/
function multiPickerValue(
  formValue: string | string[],
  isMulti: boolean,
  delim = EVENT_MULTI_SEPARATOR,
): string | string[] {
  if (isMulti === false) {
    return String(formValue)
  }
  if (formValue?.length > 0 && typeof formValue === "string") {
    return formValue.split(delim)
  }
  return []
}

/**
Whether a select field currently holds a selection. Single-select stores a plain string and
multi-select a joined one, so an empty string is the cleared state for both.
*/
function hasSelectValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return typeof value === "string" && value.trim().length > 0
}

const $root: ViewStyle = {
  flex: 1,
  padding: 10,
}

const $dropDownStyle: ViewStyle = {
  marginTop: 4,
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  zIndex: 990000,
  flex: 1,
}

const $modalContentContainerStyle: ViewStyle = {
  marginTop: 4,
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  zIndex: 990000,
  flex: 1,
}

const $fileButtonStyle: ViewStyle = {
  flex: 1,
}

const $separator: ViewStyle = {
  borderBottomWidth: 1,
  borderBottomColor: colors.palette.neutral400,
  marginTop: 4,
}
