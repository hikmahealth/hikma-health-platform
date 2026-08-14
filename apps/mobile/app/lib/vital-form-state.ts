/**
 * The text-field shape the vitals form edits, and the conversions between it and
 * a stored PatientVitals record. Free of React so the clinical arithmetic can be
 * exercised directly.
 */

import { Option } from "effect"

import PatientVitals from "@/models/PatientVitals"
import type { UpdateVitalsInput } from "../../types/vitals"

export interface VitalsState {
  systolicBp: string
  diastolicBp: string
  bpPosition: PatientVitals.BPPosition | ""
  pulseRate: string
  temperature: string
  temperatureUnit: "celsius" | "fahrenheit"
  oxygenSaturation: string
  respiratoryRate: string
  painLevel: string
  waistCircumference: string
  heightCm: string
  weightKg: string
}

export const emptyVitalsState: VitalsState = {
  systolicBp: "",
  diastolicBp: "",
  bpPosition: "",
  pulseRate: "",
  temperature: "",
  // Temperature is stored in celsius, so the form starts there rather than
  // unset: a definite unit is what lets the range check reject a Fahrenheit
  // reading instead of recording it as an absurd celsius one.
  temperatureUnit: "celsius",
  oxygenSaturation: "",
  respiratoryRate: "",
  painLevel: "",
  waistCircumference: "",
  heightCm: "",
  weightKg: "",
}

const numberField = (value: Option.Option<number>): string =>
  Option.match(value, { onNone: () => "", onSome: (n) => String(n) })

/** Blank and unparseable input both read as cleared. */
const numberInput = (value: string): Option.Option<number> => {
  if (value.trim().length === 0) return Option.none()
  const parsed = parseFloat(value)
  return Number.isNaN(parsed) ? Option.none() : Option.some(parsed)
}

/** Temperature is stored in celsius, so the unit toggle starts there. */
export const toFormState = (vital: PatientVitals.T): VitalsState => ({
  systolicBp: numberField(vital.systolicBp),
  diastolicBp: numberField(vital.diastolicBp),
  bpPosition: Option.getOrElse(vital.bpPosition, () => "" as const),
  pulseRate: numberField(vital.pulseRate),
  temperature: numberField(vital.temperatureCelsius),
  temperatureUnit: "celsius",
  oxygenSaturation: numberField(vital.oxygenSaturation),
  respiratoryRate: numberField(vital.respiratoryRate),
  painLevel: numberField(vital.painLevel),
  waistCircumference: numberField(vital.waistCircumferenceCm),
  heightCm: numberField(vital.heightCm),
  weightKg: numberField(vital.weightKg),
})

/**
 * A stored BMI survives only while the form holds neither measurement. Once
 * either is present the BMI must follow from the form, or the record would carry
 * a BMI its own height and weight contradict.
 */
export const computeBmi = (form: VitalsState, storedBmi: Option.Option<number>): string | null => {
  const height = parseFloat(form.heightCm)
  const weight = parseFloat(form.weightKg)
  if (height > 0 && weight > 0) {
    const heightInMeters = height / 100
    return (weight / (heightInMeters * heightInMeters)).toFixed(1)
  }

  const hasMeasurement = form.heightCm.trim().length > 0 || form.weightKg.trim().length > 0
  if (hasMeasurement) return null

  const stored = Option.getOrNull(storedBmi)
  return stored === null ? null : stored.toFixed(1)
}

/** Heart rate is excluded: the form never collects it, so an edit must not clear it. */
export type FormMeasurements = Required<Omit<UpdateVitalsInput, "heartRate">>

export const toMeasurements = (form: VitalsState, bmi: string | null): FormMeasurements => ({
  systolicBp: numberInput(form.systolicBp),
  diastolicBp: numberInput(form.diastolicBp),
  bpPosition: form.bpPosition ? Option.some(form.bpPosition) : Option.none(),
  pulseRate: numberInput(form.pulseRate),
  temperatureCelsius: Option.map(numberInput(form.temperature), (temp) =>
    form.temperatureUnit === "fahrenheit" ? ((temp - 32) * 5) / 9 : temp,
  ),
  oxygenSaturation: numberInput(form.oxygenSaturation),
  respiratoryRate: numberInput(form.respiratoryRate),
  painLevel: numberInput(form.painLevel),
  waistCircumferenceCm: numberInput(form.waistCircumference),
  heightCm: numberInput(form.heightCm),
  weightKg: numberInput(form.weightKg),
  bmi: bmi ? Option.some(parseFloat(bmi)) : Option.none(),
})
