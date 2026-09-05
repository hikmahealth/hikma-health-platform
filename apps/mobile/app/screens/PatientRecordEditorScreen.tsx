import { FC, useEffect, useMemo, useState } from "react"
import { Alert, Pressable, ViewStyle } from "react-native"
import { captureException } from "@sentry/react-native"
import { useSelector } from "@xstate/react"
import { format } from "date-fns"
import { Option } from "effect"
import { upperFirst } from "es-toolkit/compat"
import { LucideArrowRight } from "lucide-react-native"
import DropDownPicker from "react-native-dropdown-picker"
import Toast from "react-native-root-toast"

import { Button } from "@/components/Button"
import { DateOfBirthInput } from "@/components/DateOfBirthInput"
import { DatePickerButton } from "@/components/DatePicker"
import { If } from "@/components/If"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { Checkbox } from "@/components/Toggle/Checkbox"
import { Radio } from "@/components/Toggle/Radio"
import { View } from "@/components/View"
import { useClinics } from "@/hooks/useClinicsList"
import { useCreatePatient } from "@/hooks/useCreatePatient"
import { useDebounce } from "@/hooks/useDebounce"
import { getBaseFieldByColumn, usePatientRecordEditor } from "@/hooks/usePatientRecordEditor"
import { usePatientRecordRules } from "@/hooks/usePatientRecordRules"
import { usePermissionGuard } from "@/hooks/usePermissionGuard"
import { useSimilarPatientsSearch } from "@/hooks/useSimilarPatientsSearch"
import { useUpdatePatient } from "@/hooks/useUpdatePatient"
import { translate } from "@/i18n/translate"
import Patient from "@/models/Patient"
import PatientRegistrationForm from "@/models/PatientRegistrationForm"
import { PatientStackScreenProps } from "@/navigators/PatientNavigator"
import {
  filterVisibleFields,
  formatComputedValue,
  getComputed,
  hasComputed,
  summarizeSubmitBlockers,
} from "@/lib/form-rules"
import { useDataAccess } from "@/providers/DataAccessProvider"
import {
  patientRecordToCreateInput,
  patientRecordToUpdateInput,
} from "@/providers/transformers/patientRecordToInput"
import { languageStore } from "@/store/language"
import { providerStore } from "@/store/provider"
import { colors } from "@/theme/colors"
import { parseYYYYMMDD } from "@/utils/date"
import { toggleStringInArray, isValidUUID } from "@/utils/misc"
import { getTranslation, splitCheckboxValues, joinCheckboxValues } from "@/utils/parsers"
import { useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"
import { Logger } from "@hikmahealth/js-utils"
// import { useNavigation } from "@react-navigation/native"

interface PatientRecordEditorScreenProps extends PatientStackScreenProps<"PatientRecordEditor"> {}

export const PatientRecordEditorScreen: FC<PatientRecordEditorScreenProps> = ({
  navigation,
  route,
}) => {
  const { language, isRTL } = useSelector(languageStore, (state) => state.context)
  const {
    id: providerId,
    clinic_id: clinicId,
    clinic_name: clinicName,
    name: providerName,
  } = useSelector(providerStore, (state) => state.context)
  const editPatientId = route?.params?.editPatientId
  const { isOnline } = useDataAccess()
  const { can } = usePermissionGuard()
  const createPatientMutation = useCreatePatient()
  const updatePatientMutation = useUpdatePatient()

  // Field id → true when another patient already holds this field's value.
  // Generalizes the former government_id-only duplicate check to every field
  // the admin marked `unique`.
  const [uniqueViolations, setUniqueViolations] = useState<Record<string, boolean>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)

  const { paddingTop: safeAreaPaddingTop, paddingBottom: safeAreaPaddingBottom } =
    useSafeAreaInsetsStyle(["top", "bottom"])

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { clinics, isLoading: isLoadingClinics } = useClinics()
  const clinicOptionsList = clinics.map((clinic) => ({
    label: clinic.name,
    value: clinic.id,
  }))
  const {
    formFields,
    updateField,
    patientRecord,
    isLoading: isPatientRecordLoading,
  } = usePatientRecordEditor(editPatientId, language)

  // Cast at the DB/app type boundary: `patientRecord.fields` is typed
  // through the DB model (`RegistrationFormModel["fields"]`) which
  // lacks the rule-slot properties and uses `column: string` instead
  // of `BaseColumn`. The mobile model adds these via `& WithInputRules`
  // but the PatientRecord type still references the DB shape — the
  // column-narrowing mismatch was pre-existing. The runtime JSON carries
  // the rule slots through unchanged, so the cast is safe.
  const ruleFields = patientRecord.fields as PatientRegistrationForm.RegistrationFormField[]

  const { evaluation: ruleEvaluation, errorsByFieldId } = usePatientRecordRules({
    fields: ruleFields,
    values: patientRecord.values,
    language,
    updateField,
    patientId: editPatientId,
    isLoading: isPatientRecordLoading,
  })

  // Fields the user has directly touched, so inline validator errors gate on
  // intent (RHF touchedFields analog). Only JSX onChange goes through
  // `userUpdateField`; the hook's writebacks and primary-clinic auto-set use
  // the raw `updateField` so they don't mark fields touched.
  const [interactedFieldIds, setInteractedFieldIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setInteractedFieldIds(new Set())
  }, [editPatientId])
  const userUpdateField = (id: string, value: unknown) => {
    setInteractedFieldIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    updateField(id, value as never)
  }

  // on mount, set the primary_clinic_id to the user's current clinic id (only for new patients or if not set);
  useEffect(() => {
    const primaryClinicFieldId = getBaseFieldByColumn("primary_clinic_id")

    if (primaryClinicFieldId && isPatientRecordLoading === false) {
      // Get the current value of the primary_clinic_id field
      const currentPrimaryClinicValue = patientRecord.values[primaryClinicFieldId.id]

      // Only set it if:
      // 1. We're creating a new patient (no editPatientId), OR
      // 2. The field is empty/undefined (patient doesn't have a primary clinic set)
      if (!editPatientId || !currentPrimaryClinicValue) {
        updateField(
          primaryClinicFieldId.id,
          Option.getOrElse(clinicId, () => ""),
        )
      }
    }
  }, [clinicId, isPatientRecordLoading, editPatientId])

  const { givenName, surname } = useMemo(() => {
    const givenName = Patient.getPatientFieldByName(patientRecord, "given_name", "") || ""
    const surname = Patient.getPatientFieldByName(patientRecord, "surname", "") || ""
    return { givenName, surname }
  }, [patientRecord.values])

  // Manage the state of whihch dropdown is open
  const [openDropdown, setOpenDropdown] = useState<"primary_clinic_id" | null>(null)

  /** Background patient search for similar existing patients */
  const similarPatients = useSimilarPatientsSearch(givenName, surname)

  /** Update nav title if there is a user we are updating */
  useEffect(() => {
    if (editPatientId && typeof editPatientId === "string" && editPatientId.length > 3) {
      navigation.setOptions({
        title: translate("newPatient:updatePatient"),
      })
    }
  }, [editPatientId])

  // Fields the admin flagged unique. government_id is always treated as
  // unique so the duplicate guard still holds on deployments whose stored
  // form predates the `unique` flag (where it decodes to `false`).
  const uniqueFields = useMemo(
    () =>
      ruleFields.filter(
        (f) => (f.unique || f.column === "government_id") && f.visible && !f.deleted,
      ),
    [ruleFields],
  )

  const excludePatientId = typeof editPatientId === "string" ? editPatientId : undefined

  // Query the local DB for values already held by another, non-deleted
  // patient. Returns the ids of the violating fields. Used by both the
  // debounced live check and the authoritative on-submit check.
  const findUniqueViolations = async (): Promise<string[]> => {
    const results = await Promise.all(
      uniqueFields.map(async (field) => {
        const exists = await Patient.DB.checkUniqueFieldValue({
          field,
          value: patientRecord.values[field.id],
          fields: ruleFields,
          excludePatientId,
        })
        return exists ? field.id : null
      }),
    )
    return results.filter((id): id is string => id !== null)
  }

  // Re-check only when a unique field's value actually changes; debounced so
  // we don't hit the DB on every keystroke.
  const uniqueValuesSignature = useDebounce(
    JSON.stringify(uniqueFields.map((f) => [f.id, patientRecord.values[f.id] ?? null])),
    800,
  )

  useEffect(() => {
    let cancelled = false
    findUniqueViolations()
      .then((violatingIds) => {
        if (cancelled) return
        const next: Record<string, boolean> = {}
        for (const id of violatingIds) next[id] = true
        setUniqueViolations(next)
      })
      .catch((error) => Logger.warn(error))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueValuesSignature])

  /** Navigate to the patient file */
  const openPatientFile = (id: string) => () => {
    if (id.length < 5) {
      Logger.error("Attempting to open a patient file with an invalid patient id")
      return
    }
    navigation.navigate("PatientView", {
      patientId: id,
    })
  }

  const onSubmit = async () => {
    if (isSubmitting) return

    // Authoritative uniqueness re-check. The debounced live check is UX
    // sugar and can lag a fast typist, so re-run it here before writing.
    const uniqueViolationIds = await findUniqueViolations()
    if (uniqueViolationIds.length > 0) {
      const next: Record<string, boolean> = {}
      for (const id of uniqueViolationIds) next[id] = true
      setUniqueViolations(next)
    }
    const uniqueViolationNames = uniqueViolationIds.map((id) => {
      const field = uniqueFields.find((f) => f.id === id)
      return field ? getTranslation(field.label, language) : id
    })

    // Validate required fields + validator rules before submission.
    // All gates share one Alert — two sequential alerts would clobber
    // each other on most platforms. Validator dedup lives in
    // `summarizeSubmitBlockers`.
    const gate = summarizeSubmitBlockers({
      missingFieldNames: PatientRegistrationForm.getMissingRequiredFields({
        fields: ruleFields,
        values: patientRecord.values,
        evaluation: ruleEvaluation,
      }),
      validatorErrors: ruleEvaluation.validationErrors,
    })
    if (gate.blocked || uniqueViolationNames.length > 0) {
      const parts: string[] = []
      if (gate.missingRequired.length > 0) {
        parts.push(
          translate("newPatient:requiredFieldsMissing", {
            fields: gate.missingRequired.join(", "),
          }),
        )
      }
      if (gate.validatorErrors.length > 0) {
        parts.push(gate.validatorErrors.map((e) => e.message).join("\n"))
      }
      if (uniqueViolationNames.length > 0) {
        parts.push(
          translate("newPatient:uniqueFieldsTaken", {
            fields: uniqueViolationNames.join(", "),
          }),
        )
      }
      Alert.alert(translate("common:error"), parts.join("\n\n"))
      return
    }

    const operation = editPatientId ? "patient:edit" : "patient:register"
    if (!can(operation)) {
      Toast.show(
        editPatientId
          ? "You do not have permission to edit patient records"
          : "You do not have permission to register new patients",
        { position: Toast.positions.BOTTOM },
      )
      return
    }

    const provider = {
      id: providerId,
      name: providerName,
    }
    const clinic = {
      id: Option.getOrElse(clinicId, () => "Unknown"),
      name: Option.getOrElse(clinicName, () => "Unknown"),
    }

    const onSuccess = (patientId: string | undefined) => {
      const redirectPatientId = patientId ?? editPatientId
      if (redirectPatientId === undefined) {
        return navigation.goBack()
      }
      Alert.alert(translate("common:success"), translate("newPatient:successfulSave"), [
        {
          text: translate("newPatient:done"),
          onPress: () => navigation.goBack(),
        },
        {
          text: translate("newPatient:continueToVisits"),
          onPress: () => {
            return navigation.replace("NewVisit", {
              patientId: redirectPatientId,
              visitDate: new Date().getTime(),
              visitId: null,
            })
          },
        },
      ])
    }

    const onError = (error: unknown) => {
      Logger.error(error)
      if (typeof captureException === "function") {
        captureException(error as Error, {
          tags: {
            section: "patient_record_editor",
            action: editPatientId ? "update_patient" : "register_patient",
          },
          extra: {
            providerId,
            clinicId: Option.getOrElse(clinicId, () => "Unknown"),
            editPatientId,
            patientRecord: JSON.stringify(patientRecord.values),
          },
        })
      }
      Alert.alert(translate("common:error"), translate("newPatient:errorSaving"))
    }

    const isUpdate = typeof editPatientId === "string" && isValidUUID(editPatientId)

    setIsSubmitting(true)
    try {
      if (isOnline) {
        if (isUpdate) {
          const input = patientRecordToUpdateInput(patientRecord)
          Logger.log(
            `[PatientEditor] Online update — id: ${editPatientId},
            input: ${JSON.stringify(input, null, 2)}`,
          )
          await updatePatientMutation.mutateAsync({ id: editPatientId, data: input })
          onSuccess(editPatientId)
        } else {
          const input = patientRecordToCreateInput(
            patientRecord,
            Option.getOrElse(clinicId, () => "Unknown"),
          )
          Logger.log({
            msg: "[PatientEditor] Online create — input:",
            data: JSON.stringify(input, null, 2),
          })
          const result = await createPatientMutation.mutateAsync(input)
          onSuccess(result.id)
        }
      } else {
        if (isUpdate) {
          await Patient.DB.updateById(editPatientId, patientRecord, provider, clinic)
          onSuccess(editPatientId)
        } else {
          const patientId = await Patient.DB.register(patientRecord, provider, clinic)
          onSuccess(patientId)
        }
      }
    } catch (error) {
      Logger.error({ msg: "[PatientEditor] Submit error:", error })
      onError(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const $rtl = isRTL ? $rtlStyle : {}

  return (
    <Screen style={$root} keyboardOffset={64} preset="scroll" safeAreaEdges={["bottom"]}>
      <View gap={10} pb={40}>
        {filterVisibleFields(
          formFields.filter((field) => field.visible),
          ruleEvaluation,
        ).map((field) => {
          const { type, label, value } = field
          const fieldErrors = errorsByFieldId.get(field.id)

          // Computed fields render as a read-only labelled display of the
          // computed value. The writeback effect keeps patientRecord.values
          // in sync; submit reads from there.
          if (hasComputed(ruleEvaluation, field.id)) {
            const computed = getComputed(ruleEvaluation, field.id)
            return (
              <View key={field.id}>
                <Text preset="formLabel" text={label} withAsterisk={field.required} />
                <Text text={formatComputedValue(computed)} />
                {fieldErrors && fieldErrors.length > 0 && (
                  <View pt={4}>
                    {fieldErrors.map((err) => (
                      <Text key={err.validatorId} style={$validatorErrorText}>
                        {err.message}
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            )
          }

          return (
            <View key={field.id}>
              {(type === "text" || type === "number") && field.column !== "primary_clinic_id" && (
                <TextField
                  keyboardType={type === "number" ? "number-pad" : "default"}
                  value={String(value)}
                  onChangeText={(t) => userUpdateField(field.id, type === "number" ? Number(t) : t)}
                  label={label}
                  required={field.required}
                  testID={`patient_form_input__${field.type}__${field.column}`}
                  inputWrapperStyle={
                    uniqueViolations[field.id]
                      ? {
                          borderColor: colors.palette.angry500,
                        }
                      : {}
                  }
                />
              )}
              <If condition={!!uniqueViolations[field.id]}>
                <Text tx={"newPatient:uniqueFieldTaken"} style={$validatorErrorText} />
              </If>

              <If condition={field.column === "primary_clinic_id"}>
                <View>
                  <Text preset="formLabel" text={label} withAsterisk={field.required} />
                  <DropDownPicker
                    open={openDropdown === field.column}
                    setOpen={(open) => {
                      if (open as unknown as boolean) setOpenDropdown(field.column as any)
                      else setOpenDropdown(null)
                    }}
                    testID={`patient_form_input__${field.type}__${field.column}`}
                    modalTitle="Primary Clinic"
                    rtl={isRTL}
                    style={$dropDownPickerStyle}
                    zIndex={990000}
                    zIndexInverse={990000}
                    listMode="MODAL"
                    modalContentContainerStyle={[
                      $modalContentContainerStyle,
                      { paddingTop: safeAreaPaddingTop, marginBottom: safeAreaPaddingBottom },
                    ]}
                    items={clinicOptionsList}
                    value={value}
                    setValue={(cb) => {
                      const data = cb(value)
                      userUpdateField(field.id, data)
                    }}
                  />
                </View>
              </If>

              {type === "date" && field.column === "date_of_birth" && (
                <View>
                  <DateOfBirthInput
                    label={label}
                    required={field.required}
                    testId={`patient_form_input__${field.type}__${field.column}`}
                    date={parseYYYYMMDD(value, new Date())}
                    onChangeDate={(d) => {
                      if (d && parseYYYYMMDD(d.toDateString(), undefined)) {
                        userUpdateField(field.id, format(d, "yyyy-MM-dd"))
                      }
                    }}
                    ageEntryProps={{ day: 1, month: 0 }}
                  />
                </View>
              )}

              {type === "date" && field.column !== "date_of_birth" && (
                <View>
                  <View style={$rtl}>
                    <Text text={label} preset="formLabel" withAsterisk={field.required} />
                  </View>
                  <View>
                    <DatePickerButton
                      locale="en-US"
                      modal
                      testID={`patient_form_input__${field.type}__${field.column}`}
                      theme="light"
                      maximumDate={new Date()}
                      title={label}
                      date={parseYYYYMMDD(value, new Date())}
                      onDateChange={(d) =>
                        d &&
                        parseYYYYMMDD(d.toDateString(), undefined) &&
                        userUpdateField(field.id, format(d, "yyyy-MM-dd"))
                      }
                    />
                  </View>
                </View>
              )}

              {type === "select" && (
                <View>
                  <View style={$rtl}>
                    <Text text={label} preset="formLabel" withAsterisk={field.required} />
                  </View>
                  <View gap={6} pt={6}>
                    {field.options.map((fieldOption) => (
                      <Radio
                        key={fieldOption.en}
                        label={upperFirst(getTranslation(fieldOption, language))}
                        value={value === getTranslation(fieldOption, language)}
                        onValueChange={(value) => {
                          if (value) {
                            userUpdateField(field.id, getTranslation(fieldOption, language))
                          }
                        }}
                      />
                    ))}
                  </View>
                </View>
              )}

              {type === "checkbox" && (
                <View>
                  <View style={$rtl}>
                    <Text text={label} preset="formLabel" withAsterisk={field.required} />
                  </View>
                  <View gap={6} pt={6}>
                    {field.options.map((fieldOption) => {
                      const optionLabel = getTranslation(fieldOption, language)
                      const selected = splitCheckboxValues(typeof value === "string" ? value : "")
                      return (
                        <Checkbox
                          key={fieldOption.en}
                          label={upperFirst(optionLabel)}
                          value={selected.includes(optionLabel)}
                          onValueChange={() => {
                            userUpdateField(
                              field.id,
                              joinCheckboxValues(toggleStringInArray(optionLabel, selected)),
                            )
                          }}
                        />
                      )
                    })}
                  </View>
                </View>
              )}
              {/* Gated on user interaction so an untouched field whose
                    rule fails against undefined doesn't flash red on first
                    render. Submit consolidation still surfaces everything. */}
              {interactedFieldIds.has(field.id) && fieldErrors && fieldErrors.length > 0 && (
                <View pt={4}>
                  {fieldErrors.map((err) => (
                    <Text key={err.validatorId} style={$validatorErrorText}>
                      {err.message}
                    </Text>
                  ))}
                </View>
              )}
            </View>
          )
        })}

        <If condition={similarPatients.length > 0 && typeof editPatientId !== "string"}>
          <View gap={8} style={$similarPatientsContainer}>
            <Text
              weight="semiBold"
              tx="newPatient:similarFoundPatients"
              style={$similarPatientsTitle}
            />
            {similarPatients.slice(0, 5).map((patient) => (
              <Pressable
                key={patient.id}
                onPress={openPatientFile(patient.id)}
                style={$patientPressable}
              >
                <View>
                  <Text text={`${patient.givenName} ${patient.surname}`} />
                  <Text text={`${translate("common:dob")}: ${patient.dateOfBirth}`} />
                </View>
                <LucideArrowRight color={colors.textDim} size={16} />
              </Pressable>
            ))}
          </View>
        </If>

        <Button
          preset="default"
          disabled={Object.values(uniqueViolations).some(Boolean) || isSubmitting}
          onPress={() => onSubmit()}
          testID="submit"
        >
          {isSubmitting ? translate("common:loading") : translate("common:save")}
        </Button>
      </View>

      <View style={$spacer} />
    </Screen>
  )
}

const $root: ViewStyle = {
  flex: 1,
  paddingHorizontal: 10,
}

const $similarPatientsContainer: ViewStyle = {
  backgroundColor: "#ffea99",
  borderRadius: 8,
  padding: 10,
}

const $similarPatientsTitle: ViewStyle = {
  marginBottom: 8,
}

const $patientPressable: ViewStyle = {
  flexDirection: "row",
  justifyContent: "space-between",
  borderBottomWidth: 1,
  borderBottomColor: "#7f6600",
  alignItems: "center",
}

const $spacer: ViewStyle = {
  height: 40,
}

const $rtlStyle: ViewStyle = { flexDirection: "row-reverse" }

const $dropDownPickerStyle: ViewStyle = {
  marginTop: 2,
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  zIndex: 990000,
  flex: 1,
}

const $validatorErrorText = {
  color: colors.palette.angry500,
  fontSize: 13,
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
