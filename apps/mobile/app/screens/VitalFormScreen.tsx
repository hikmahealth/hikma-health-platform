import { FC, useState, useMemo, useEffect, useRef } from "react"
import { ViewStyle, TextStyle, ScrollView, Alert } from "react-native"
import { useSelector } from "@xstate/react"
import { Option } from "effect"

import Toast from "react-native-root-toast"

import { Button } from "@/components/Button"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { Radio } from "@/components/Toggle/Radio"
import { View } from "@/components/View"
import { usePermissionGuard } from "@/hooks/usePermissionGuard"
import { useCreateVitals } from "@/hooks/useCreateVitals"
import { usePatientVitals } from "@/hooks/usePatientVitals"
import { useUpdateVitals } from "@/hooks/useUpdateVitals"
import { translate } from "@/i18n/translate"
import {
  computeBmi,
  emptyVitalsState,
  toFormState,
  toMeasurements,
  type VitalsState,
} from "@/lib/vital-form-state"
import PatientVitals from "@/models/PatientVitals"
import { PatientStackScreenProps } from "@/navigators/PatientNavigator"
import { providerStore } from "@/store/provider"
import { spacing } from "@/theme/spacing"
import { Logger } from "@hikmahealth/js-utils"

interface VitalFormScreenProps extends PatientStackScreenProps<"VitalForm"> {}

export const VitalFormScreen: FC<VitalFormScreenProps> = ({ route, navigation }) => {
  const { patientId, vitalId } = route.params
  const editingId = typeof vitalId === "string" && vitalId.length > 0 ? vitalId : null
  const isEditing = editingId !== null
  const providerId = useSelector(providerStore, (state) => state.context.id)
  const { can } = usePermissionGuard()
  const createVitalsMutation = useCreateVitals()
  const updateVitalsMutation = useUpdateVitals()

  // Only loaded when editing; the create flow has nothing to prefill from.
  const existingVitals = usePatientVitals(isEditing ? patientId : "")
  const existingVital = useMemo(
    () => existingVitals.find((vital) => vital.id === editingId),
    [existingVitals, editingId],
  )

  const [vitals, setVitals] = useState<VitalsState>(emptyVitalsState)

  // Seed once per record: the offline subscription re-emits on every write to
  // the table, and re-seeding would discard what the user has typed.
  const seededId = useRef<string | null>(null)
  useEffect(() => {
    if (!existingVital) return
    if (seededId.current === existingVital.id) return
    seededId.current = existingVital.id
    setVitals(toFormState(existingVital))
  }, [existingVital])

  const [errors, setErrors] = useState<Partial<Record<keyof VitalsState, string>>>({})

  const bmi = useMemo(
    () => computeBmi(vitals, existingVital ? existingVital.bmi : Option.none()),
    [vitals, existingVital],
  )

  const updateVital = (
    key: keyof VitalsState,
    value: string | PatientVitals.BPPosition | "celsius" | "fahrenheit",
  ) => {
    setVitals((prev) => ({ ...prev, [key]: value }))
    // Clear error when user starts typing
    if (errors[key]) {
      setErrors((prev) => ({ ...prev, [key]: undefined }))
    }
  }

  const validateVitals = (): boolean => {
    const newErrors: Partial<Record<keyof VitalsState, string>> = {}

    // Blood pressure validation
    if (vitals.systolicBp) {
      const systolic = parseFloat(vitals.systolicBp)
      if (isNaN(systolic) || systolic < 70 || systolic > 250) {
        newErrors.systolicBp = "Systolic BP should be between 70-250 mmHg"
      }
    }

    if (vitals.diastolicBp) {
      const diastolic = parseFloat(vitals.diastolicBp)
      if (isNaN(diastolic) || diastolic < 40 || diastolic > 150) {
        newErrors.diastolicBp = "Diastolic BP should be between 40-150 mmHg"
      }
    }

    // If BP values are entered, position should be selected
    if ((vitals.systolicBp || vitals.diastolicBp) && !vitals.bpPosition) {
      newErrors.bpPosition = "Please select BP position"
    }

    // Pulse rate validation
    if (vitals.pulseRate) {
      const pulse = parseFloat(vitals.pulseRate)
      if (isNaN(pulse) || pulse < 30 || pulse > 250) {
        newErrors.pulseRate = "Pulse rate should be between 30-250 bpm"
      }
    }

    // Temperature validation. Each scale is checked against its own range, which
    // is what catches a Fahrenheit reading typed against the Celsius default —
    // `toMeasurements` would otherwise store the raw number as Celsius.
    if (vitals.temperature) {
      const temp = parseFloat(vitals.temperature)
      if (vitals.temperatureUnit === "celsius") {
        if (isNaN(temp) || temp < 30 || temp > 45) {
          newErrors.temperature = "Temperature should be between 30-45°C"
        }
      } else {
        if (isNaN(temp) || temp < 86 || temp > 113) {
          newErrors.temperature = "Temperature should be between 86-113°F"
        }
      }
    }

    // Oxygen saturation validation
    if (vitals.oxygenSaturation) {
      const o2 = parseFloat(vitals.oxygenSaturation)
      if (isNaN(o2) || o2 < 50 || o2 > 100) {
        newErrors.oxygenSaturation = "Oxygen saturation should be between 50-100%"
      }
    }

    // Respiratory rate validation
    if (vitals.respiratoryRate) {
      const rr = parseFloat(vitals.respiratoryRate)
      if (isNaN(rr) || rr < 5 || rr > 60) {
        newErrors.respiratoryRate = "Respiratory rate should be between 5-60 bpm"
      }
    }

    // Pain level validation
    if (vitals.painLevel) {
      const pain = parseFloat(vitals.painLevel)
      if (isNaN(pain) || pain < 0 || pain > 10) {
        newErrors.painLevel = "Pain level should be between 0-10"
      }
    }

    // Waist circumference validation
    if (vitals.waistCircumference) {
      const waist = parseFloat(vitals.waistCircumference)
      if (isNaN(waist) || waist < 40 || waist > 200) {
        newErrors.waistCircumference = "Waist circumference should be between 40-200 cm"
      }
    }

    // Height validation
    if (vitals.heightCm) {
      const height = parseFloat(vitals.heightCm)
      if (isNaN(height) || height < 50 || height > 250) {
        newErrors.heightCm = "Height should be between 50-250 cm"
      }
    }

    // Weight validation
    if (vitals.weightKg) {
      const weight = parseFloat(vitals.weightKg)
      if (isNaN(weight) || weight < 1 || weight > 300) {
        newErrors.weightKg = "Weight should be between 1-300 kg"
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const save = async () => {
    if (!can(isEditing ? "vitals:edit" : "vitals:create")) {
      return Toast.show(
        isEditing
          ? "You do not have permission to edit vitals"
          : "You do not have permission to record vitals",
        {
          duration: Toast.durations.SHORT,
          position: Toast.positions.BOTTOM,
        },
      )
    }
    if (!validateVitals()) {
      Alert.alert("Validation Error", "Please correct the errors before saving")
      return
    }

    const measurements = toMeasurements(vitals, bmi)

    try {
      if (editingId) {
        await updateVitalsMutation.mutateAsync({ id: editingId, data: measurements })
      } else {
        const vitalData: Omit<PatientVitals.T, "id" | "createdAt" | "updatedAt" | "deletedAt"> = {
          ...measurements,
          patientId: patientId,
          visitId: Option.none(), // TODO: Pass visitId if available from route params
          timestamp: new Date(),
          heartRate: Option.none(), // Not collected in this form
          recordedByUserId: Option.some(providerId), // TODO: Get from current user context
          metadata: {},
          isDeleted: false,
        }
        await createVitalsMutation.mutateAsync(vitalData)
      }

      Alert.alert(
        "Success",
        isEditing ? "Vitals updated successfully" : "Vitals saved successfully",
        [{ text: "OK", onPress: () => navigation.goBack() }],
      )
    } catch (error) {
      Logger.error({ msg: "Error saving vitals:", error })
      Alert.alert("Error", "Failed to save vitals. Please try again.")
    }
  }

  // Saving before the entry loads would overwrite it with a blank form.
  const isEntryPending = isEditing && !existingVital

  return (
    <Screen style={$root} preset="scroll">
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={$section}>
          {isEntryPending && (
            <View mb={spacing.md}>
              <Text text={translate("vitalForm:loadingEntry")} size="xs" />
            </View>
          )}

          {/* Blood Pressure Section */}
          <View mb={0}>
            <Text text="Blood Pressure" preset="formLabel" style={$label} />
            <View style={$bpRow}>
              <View style={$bpInput}>
                <TextField
                  placeholder="Systolic"
                  value={vitals.systolicBp}
                  onChangeText={(text) => updateVital("systolicBp", text)}
                  keyboardType="numeric"
                  helper={errors.systolicBp}
                  status={errors.systolicBp ? "error" : undefined}
                  label="Systolic (mmHg)"
                />
              </View>
              <Text text="/" style={$bpSeparator} />
              <View style={$bpInput}>
                <TextField
                  placeholder="Diastolic"
                  value={vitals.diastolicBp}
                  onChangeText={(text) => updateVital("diastolicBp", text)}
                  keyboardType="numeric"
                  helper={errors.diastolicBp}
                  status={errors.diastolicBp ? "error" : undefined}
                  label="Diastolic (mmHg)"
                />
              </View>
            </View>

            {/* BP Position Radio Group */}
            <View style={$radioGroup} mt={0} mb={10}>
              <Text text="BP Reading Position" preset="formLabel" style={$radioGroupLabel} />
              <Radio
                label="Sitting"
                value={vitals.bpPosition === "sitting"}
                onPress={() => updateVital("bpPosition", "sitting")}
              />
              <Radio
                label="Standing"
                value={vitals.bpPosition === "standing"}
                onPress={() => updateVital("bpPosition", "standing")}
              />
              <Radio
                label="Lying"
                value={vitals.bpPosition === "lying"}
                onPress={() => updateVital("bpPosition", "lying")}
              />
              <Radio
                label="Other"
                value={vitals.bpPosition === "other"}
                onPress={() => updateVital("bpPosition", "other")}
              />
              {errors.bpPosition && <Text text={errors.bpPosition} size="xs" style={$errorText} />}
            </View>
          </View>

          {/* Pulse Rate */}
          <View mb={spacing.md} mt={20}>
            <TextField
              label="Pulse Rate (bpm)"
              placeholder="Enter pulse rate"
              value={vitals.pulseRate}
              onChangeText={(text) => updateVital("pulseRate", text)}
              keyboardType="numeric"
              helper={errors.pulseRate || ""}
              status={errors.pulseRate ? "error" : undefined}
            />
          </View>

          {/* Temperature */}
          <View mb={spacing.md}>
            <TextField
              label={`Temperature (°${vitals.temperatureUnit === "celsius" ? "C" : "F"})`}
              placeholder="Enter temperature"
              value={vitals.temperature}
              onChangeText={(text) => updateVital("temperature", text)}
              keyboardType="decimal-pad"
              helper={errors.temperature}
              status={errors.temperature ? "error" : undefined}
            />
            <View direction="row" pt={8}>
              <View flex={1}>
                <Radio
                  label="Celsius"
                  value={vitals.temperatureUnit === "celsius"}
                  onPress={() => updateVital("temperatureUnit", "celsius")}
                />
              </View>
              <View flex={1}>
                <Radio
                  label="Fahrenheit"
                  value={vitals.temperatureUnit === "fahrenheit"}
                  onPress={() => updateVital("temperatureUnit", "fahrenheit")}
                />
              </View>
            </View>
          </View>

          {/* Oxygen Saturation */}
          <View mb={spacing.md}>
            <TextField
              label="Oxygen Saturation (%)"
              placeholder="Enter oxygen saturation"
              value={vitals.oxygenSaturation}
              onChangeText={(text) => updateVital("oxygenSaturation", text)}
              keyboardType="numeric"
              status={errors.oxygenSaturation ? "error" : undefined}
            />
          </View>

          {/* Respiratory Rate */}
          <View mb={spacing.md}>
            <TextField
              label="Respiratory Rate (bpm)"
              placeholder="Enter respiratory rate"
              value={vitals.respiratoryRate}
              onChangeText={(text) => updateVital("respiratoryRate", text)}
              keyboardType="numeric"
              helper={errors.respiratoryRate || ""}
              status={errors.respiratoryRate ? "error" : undefined}
            />
          </View>

          {/* Pain Level */}
          <View mb={spacing.md}>
            <TextField
              label="Pain Level (0-10)"
              placeholder="Enter pain level"
              value={vitals.painLevel}
              onChangeText={(text) => updateVital("painLevel", text)}
              keyboardType="numeric"
              helper={errors.painLevel || "0 = No pain, 10 = Worst pain"}
              status={errors.painLevel ? "error" : undefined}
            />
          </View>

          {/* Anthropometric Measurements */}
          <Text text="Measurements" preset="formLabel" style={$sectionSubtitle} />

          {/* Height */}
          <View mb={spacing.md}>
            <TextField
              label="Height (cm)"
              placeholder="Enter height"
              value={vitals.heightCm}
              onChangeText={(text) => updateVital("heightCm", text)}
              keyboardType="numeric"
              helper={errors.heightCm || ""}
              status={errors.heightCm ? "error" : undefined}
            />
          </View>

          {/* Weight */}
          <View mb={spacing.md}>
            <TextField
              label="Weight (kg)"
              placeholder="Enter weight"
              value={vitals.weightKg}
              onChangeText={(text) => updateVital("weightKg", text)}
              keyboardType="decimal-pad"
              helper={errors.weightKg || ""}
              status={errors.weightKg ? "error" : undefined}
            />
          </View>

          {/* BMI Display */}
          {bmi && (
            <View mb={spacing.md}>
              <View style={$bmiDisplay}>
                <Text text="BMI:" preset="formLabel" />
                <Text text={` ${bmi} kg/m²`} preset="bold" />
              </View>
              {/* Height and weight are each range-checked on their own, so a
                  transposed or mistyped pair can still produce a BMI no patient
                  has. Advisory only: the value is saved either way, since the
                  extremes this flags are occasionally real. */}
              {parseFloat(bmi) > 100 && (
                <Text
                  text="BMI over 100 — check the height and weight are in cm and kg."
                  size="xs"
                  style={$warningText}
                />
              )}
            </View>
          )}

          {/* Waist Circumference */}
          <View mb={spacing.md}>
            <TextField
              label="Waist Circumference (cm)"
              placeholder="Enter waist circumference"
              value={vitals.waistCircumference}
              onChangeText={(text) => updateVital("waistCircumference", text)}
              keyboardType="numeric"
              helper={errors.waistCircumference || ""}
              status={errors.waistCircumference ? "error" : undefined}
            />
          </View>

          <View style={$buttonContainer}>
            <Button
              text="Cancel"
              preset="default"
              onPress={() => navigation.goBack()}
              style={$button}
            />
            <Button
              text="Save"
              preset="filled"
              onPress={save}
              disabled={isEntryPending}
              style={$button}
            />
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}

const $root: ViewStyle = {
  flex: 1,
  backgroundColor: "#F5F5F5",
}

const $section: ViewStyle = {
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.lg,
}

const $sectionSubtitle: TextStyle = {
  marginTop: spacing.lg,
  marginBottom: spacing.md,
}

const $label: TextStyle = {
  marginBottom: spacing.xs,
}

const $bpRow: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  marginBottom: spacing.sm,
}

const $bpInput: ViewStyle = {
  flex: 1,
}

const $bpSeparator: TextStyle = {
  fontSize: 24,
  paddingHorizontal: spacing.xs,
  paddingTop: spacing.md,
}

const $radioGroup: ViewStyle = {
  marginTop: spacing.sm,
  gap: spacing.xs,
}

const $radioGroupLabel: TextStyle = {
  marginBottom: spacing.xs,
}

const $errorText: TextStyle = {
  color: "#D32F2F",
  marginTop: spacing.xs,
}

const $warningText: TextStyle = {
  color: "#B26A00",
  marginTop: spacing.xs,
}

const $bmiDisplay: ViewStyle = {
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: spacing.sm,
  paddingHorizontal: spacing.md,
  backgroundColor: "#E3F2FD",
  borderRadius: 8,
}

const $buttonContainer: ViewStyle = {
  flexDirection: "row",
  justifyContent: "space-between",
  marginTop: spacing.xl,
  gap: spacing.md,
}

const $button: ViewStyle = {
  flex: 1,
}
