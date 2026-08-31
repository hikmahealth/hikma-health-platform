import { FC, useEffect, useState } from "react"
import { Platform, Pressable, ViewStyle } from "react-native"
import { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSelector } from "@xstate/react"
import { format, isToday, set } from "date-fns"
import { Option, Schema } from "effect"
import { cloneDeep } from "es-toolkit"
import { sortBy } from "es-toolkit"
import { Controller, useForm } from "react-hook-form"
import DatePicker from "react-native-date-picker"
import DropDownPicker from "react-native-dropdown-picker"
import Toast from "react-native-root-toast"

import { Button } from "@/components/Button"
import { DatePickerButton } from "@/components/DatePicker"
import { $dropDownPickerStyle, PlatformPicker } from "@/components/PlatformPicker"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { Checkbox } from "@/components/Toggle/Checkbox"
import { View } from "@/components/View"
import { useClinicDepartments } from "@/hooks/useClinicDepartments"
import { useDBClinicsList } from "@/hooks/useDBClinicsList"
import { usePermissionGuard } from "@/hooks/usePermissionGuard"
import { translate } from "@/i18n/translate"
import Appointment from "@/models/Appointment"
import { PatientNavigatorParamList } from "@/navigators/PatientNavigator"
import { providerStore } from "@/store/provider"
import { colors } from "@/theme/colors"
import { spacing } from "@/theme/spacing"
import { If } from "@/components/If"
import { useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"
import { Logger } from "@hikmahealth/js-utils"
// import { useNavigation } from "@react-navigation/native"

interface AppointmentEditorFormScreenProps extends NativeStackScreenProps<
  PatientNavigatorParamList,
  "AppointmentEditorForm"
> {}

const durationOptions = [
  { label: "Unknown", value: 0 },
  { label: translate("common:xMinutes", { count: 15 }), value: 15 },
  { label: translate("common:xMinutes", { count: 30 }), value: 30 },
  { label: translate("common:xMinutes", { count: 45 }), value: 45 },
  { label: translate("common:xHours", { count: 1 }), value: 60 },
  { label: translate("common:xHours", { count: 2 }), value: 60 * 2 },
  { label: translate("common:xHours", { count: 3 }), value: 60 * 3 },
  { label: translate("common:xHours", { count: 8 }), value: 60 * 8 },
]

const reasonOptions = [
  { label: "Doctor's Visit", value: "doctor-visit" },
  { label: "Screening", value: "screening" },
  { label: "Referral", value: "referral" },
  { label: "Checkup", value: "checkup" },
  { label: "Follow-up", value: "follow-up" },
  { label: "Counselling", value: "counselling" },
  { label: "Procedure", value: "procedure" },
  { label: "Investigation", value: "investigation" },
  { label: "Other", value: "other" },
]

// type AppointmentForm = Appointment & {
//   currentVisitId: string | null | undefined
// }

export const AppointmentEditorFormScreen: FC<AppointmentEditorFormScreenProps> = ({
  route,
  navigation,
}) => {
  const {
    providerId,
    clinicId: providerClinicId,
    name: providerName,
  } = useSelector(providerStore, (state) => ({
    providerId: state.context.id,
    clinicId: state.context.clinic_id,
  }))
  const { paddingTop: safeAreaPaddingTop } = useSafeAreaInsetsStyle(["top"])

  const [isTimePickerOpen, setIsTimePickerOpen] = useState(false)
  const { clinics, isLoading } = useDBClinicsList()
  const { can } = usePermissionGuard()

  const { visitId, patientId, appointmentId } = route.params

  // An appointmentId in the route params is what puts the screen in edit mode.
  const editingAppointmentId = appointmentId || null
  const [seeding, setSeeding] = useState<"loading" | "ready" | "missing">(
    editingAppointmentId ? "loading" : "ready",
  )

  const [openPicker, setOpenPicker] = useState<
    "clinic" | "duration" | "reason" | "department" | null
  >(null)
  const isIos = Platform.OS === "ios"

  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
    getValues,
    setValue,
    reset,
    watch,
  } = useForm<Appointment.EncodedT>({
    defaultValues: {
      ...cloneDeep(Appointment.empty),
      userId: providerId,
      currentVisitId: visitId || undefined,
      clinicId: Option.getOrUndefined(providerClinicId),
      departments: [],
      patientId,
      reason: "other",
      status: "pending",
      timestamp: set(new Date(), { hours: 17, minutes: 0, seconds: 0, milliseconds: 0 }),
      fulfilledVisitId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  })

  const { data: clinicDepartments, loading: isClinicDepartmentsLoading } = useClinicDepartments(
    watch("clinicId") || "",
  )

  useEffect(() => {
    if (!editingAppointmentId) return
    let cancelled = false

    Appointment.DB.getEncodedById(editingAppointmentId)
      .then((existing) => {
        if (cancelled) return
        if (!existing) {
          setSeeding("missing")
          return
        }
        reset(existing)
        setSeeding("ready")
      })
      .catch((error) => {
        if (cancelled) return
        Logger.error({ msg: "Failed to load appointment for editing:", error })
        setSeeding("missing")
      })

    return () => {
      cancelled = true
    }
  }, [editingAppointmentId])

  useEffect(() => {
    if (editingAppointmentId) {
      navigation.setOptions({ title: translate("appointmentView:editAppointment") })
    }
  }, [editingAppointmentId])

  const onSubmit = async (submission: Appointment.EncodedT) => {
    if (editingAppointmentId) {
      return updateAppointment(editingAppointmentId, submission)
    }
    return createAppointment(submission)
  }

  const updateAppointment = async (id: string, submission: Appointment.EncodedT) => {
    if (!can("appointment:update")) {
      Toast.show("You do not have permission to edit appointments", {
        duration: Toast.durations.SHORT,
        position: Toast.positions.BOTTOM,
      })
      return
    }
    try {
      // Status and colour tag are left to the appointment view — editing details
      // here should not re-open a completed appointment.
      await Appointment.DB.update(id, {
        timestamp: submission.timestamp,
        duration: submission.duration,
        reason: submission.reason,
        notes: submission.notes,
        isWalkIn: submission.isWalkIn,
        departments: submission.departments.map((department) => ({
          ...department,
          status: Appointment.asDepartmentStatus(department.status),
        })),
      })
      Toast.show("✅ Appointment updated", {
        position: Toast.positions.BOTTOM,
        containerStyle: {
          marginBottom: 100,
        },
      })
      navigation.goBack()
    } catch (error) {
      Logger.error({ msg: "Failed to update appointment:", error })
      Toast.show("❌ Failed to update appointment", {
        position: Toast.positions.BOTTOM,
        containerStyle: {
          marginBottom: 100,
        },
      })
    }
  }

  const createAppointment = async (submission: Appointment.EncodedT) => {
    if (!can("appointment:create")) {
      Toast.show("You do not have permission to create appointments", {
        duration: Toast.durations.SHORT,
        position: Toast.positions.BOTTOM,
      })
      return
    }
    // Making sure the data is complete and that the defaults are sane
    const data: Appointment.EncodedT = {
      ...submission,
      clinicId: submission.clinicId || Option.getOrElse(providerClinicId, () => ""),
      patientId,
      userId: providerId,
      fulfilledVisitId: null,
      // If its a walk-in, it means the patient is already here and should be checked-in.
      status: submission.isWalkIn ? "checked_in" : "pending",
      // Stamped at save, not when the toggle flipped: a form left open past
      // midnight would otherwise file under the previous day.
      timestamp: submission.isWalkIn ? new Date() : submission.timestamp,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    try {
      const res = await Appointment.DB.create(Appointment.decode(data), {
        id: providerId,
        name: providerName,
      })
      Toast.show("✅ Appointment created", {
        position: Toast.positions.BOTTOM,
        containerStyle: {
          marginBottom: 100,
        },
      })
      // React-Navigation 6 shortcut to passing a parameter to the previous screen
      // here we pop the screen and pass the visit ID to the previous screen
      // Tombstone: Oct 3rd 2025
      // navigation.dispatch((state) => {
      //   const prevRoute = state.routes[state.routes.length - 2]
      //   return CommonActions.navigate({
      //     name: prevRoute.name,
      //     params: {
      //       ...prevRoute.params,
      //       visitId: res.visitId,
      //     },
      //     merge: true,
      //   })
      // })
      navigation.goBack()
    } catch (error) {
      Logger.error({ msg: "Failed to create appointment:", error })
      Toast.show("❌ Failed to create appointment", {
        position: Toast.positions.BOTTOM,
        containerStyle: {
          marginBottom: 100,
        },
      })
      // TODO: Handle error (e.g., show error message to user)
    }
  }

  // Turning on walk-in means the patient is here now. Stamped from the toggle, not an
  // effect on the value, so seeding a saved walk-in leaves its original time alone.
  const handleWalkInChange = (onChange: (value: boolean) => void) => (isWalkIn: boolean) => {
    onChange(isWalkIn)
    if (isWalkIn) {
      setValue("timestamp", new Date())
    }
  }

  const getDepartmentById = (departmentId: string) => {
    return clinicDepartments.find((department) => department.id === departmentId)
  }

  const handleDepartmentChange = (departmentIds: string[]) => {
    const selected = getValues("departments") || []
    const departments = departmentIds.map((departmentId) => {
      // Keep the existing entry so recorded progress is not reset to pending.
      const existing = selected.find((department) => department.id === departmentId)
      if (existing) return existing

      return {
        id: departmentId,
        name: getDepartmentById(departmentId)?.name || "Unnamed Department",
        seen_at: null,
        seen_by: null,
        status: "pending",
      }
    })
    setValue("departments", departments)
  }

  const updateTime = (time: Date) => {
    // setIsTimePickerOpen(false)
    setValue("timestamp", new Date(time))
  }

  if (seeding === "loading") {
    return (
      <Screen style={$root} preset="scroll">
        <Text tx="common:loading" />
      </Screen>
    )
  }

  if (seeding === "missing") {
    return (
      <Screen style={$root} preset="scroll">
        <Text text="Appointment not found" />
      </Screen>
    )
  }

  return (
    <Screen style={$root} preset="scroll">
      <View gap={spacing.md} pt={20}>
        {/* Checkbox to determine if the appointment is_walk_in or not */}
        <Controller
          control={control}
          name="isWalkIn"
          render={({ field }) => (
            <View>
              <Checkbox
                label="This is a walk-in Appointment"
                value={field.value}
                onValueChange={handleWalkInChange(field.onChange)}
              />
            </View>
          )}
        />

        <Controller
          control={control}
          name="clinicId"
          render={({ field }) => (
            <View>
              <Text preset="formLabel" text="Clinic" />
              {/* <View style={$pickerContainer}>
                <Picker selectedValue={field.value} onValueChange={field.onChange}>
                  {sortBy(clinics, "name").map((clinic) => (
                    <Picker.Item key={clinic.id} label={clinic.name} value={clinic.id} />
                  ))}
                </Picker>
              </View> */}

              {/* Departments are scoped to a clinic, so a saved appointment stays
                  with the clinic it was booked at. */}
              <If
                condition={editingAppointmentId !== null}
                fallback={
                  <PlatformPicker
                    isIos={isIos}
                    options={sortBy(clinics, ["name"]).map((clinic) => ({
                      label: clinic.name,
                      value: clinic.id,
                    }))}
                    fieldKey="clinicId"
                    modalTitle="Clinic"
                    setValue={() => (value: string) => field.onChange(value)}
                    setOpen={(value: boolean) => setOpenPicker(value ? "clinic" : null)}
                    isOpen={openPicker === "clinic"}
                    value={field.value}
                  />
                }
              >
                <Text text={clinics.find((clinic) => clinic.id === field.value)?.name || "—"} />
              </If>
            </View>
          )}
        />

        {/* Choose the departments for the appointment */}
        <View>
          <Text preset="formLabel" tx="common:departments" />
          <DropDownPicker
            open={openPicker === "department"}
            setOpen={() => setOpenPicker("department")}
            modalTitle={translate("common:departments")}
            style={$dropDownPickerStyle}
            zIndex={990000}
            onClose={() => setOpenPicker(null)}
            zIndexInverse={990000}
            multiple
            mode="BADGE"
            listMode="MODAL"
            modalContentContainerStyle={[
              $modalContentContainerStyle,
              { paddingTop: safeAreaPaddingTop },
            ]}
            items={clinicDepartments.map((dept) => ({
              label: dept.name,
              value: dept.id,
            }))}
            value={
              watch("departments")?.map((department) => {
                return department.id
                return {
                  label: department.name,
                  value: department.id,
                }
              }) || []
            }
            onSelectItem={(items) => {
              handleDepartmentChange(items.map((it) => it.value).filter(Boolean) || [])
            }}
            // setValue={(cb) => {
            //   const depts = getValues("departments")
            //   const data = cb(depts)

            //   handleDepartmentChange(data)
            //   // TODO: add and remove the departments appropriately
            //   // setValue("departments", data || [])
            // }}
          />
        </View>

        {/* Do not allow change of date and time if is a walk in appointment. */}
        {/*This means the patient is already here. the status will be checked in*/}
        <If condition={watch("isWalkIn") === false}>
          <Controller
            control={control}
            name="timestamp"
            render={({ field }) => (
              <View>
                <Text preset="formLabel" tx="appointmentEditorForm:date" />
                <DatePickerButton
                  date={field.value}
                  mode="date"
                  disabled={watch("isWalkIn") === true}
                  onDateChange={field.onChange}
                  onConfirm={field.onChange}
                />
              </View>
            )}
          />

          <View>
            <Text preset="formLabel" tx="appointmentEditorForm:time" />
            <Pressable
              style={[$pickerContainer, { justifyContent: "flex-start", padding: 10 }]}
              disabled={watch("isWalkIn") === true}
              onPress={() => setIsTimePickerOpen(true)}
            >
              <Text>{format(getValues("timestamp"), "h:mm a")}</Text>
            </Pressable>
          </View>
        </If>

        {/*A walk-in's time is stamped by the toggle, but a saved one can be from
           any day, so only say "Today" when it is.*/}
        <If condition={watch("isWalkIn") === true}>
          <View>
            <Text preset="formLabel" tx="appointmentEditorForm:time" />
            <Text>
              {isToday(getValues("timestamp"))
                ? `Today, ${format(getValues("timestamp"), "h:mm a")}`
                : format(getValues("timestamp"), "MMM d, yyyy 'at' h:mm a")}
            </Text>
          </View>
        </If>

        <DatePicker
          modal
          open={isTimePickerOpen}
          date={watch("timestamp")}
          onConfirm={(data) => {
            updateTime(data)
            setIsTimePickerOpen(false)
          }}
          mode="time"
          onDateChange={updateTime}
          onCancel={() => setIsTimePickerOpen(false)}
        />

        {/* Duration is a drop down with the time options */}
        <Controller
          control={control}
          name="duration"
          render={({ field }) => (
            <View>
              <Text preset="formLabel" tx="appointmentEditorForm:duration" />
              {/* <View style={$pickerContainer}> */}
              {/* <Picker selectedValue={field.value} onValueChange={field.onChange}>
                  {durationOptions.map((option) => (
                    <Picker.Item key={option.value} label={option.label} value={option.value} />
                  ))}
                </Picker> */}

              <PlatformPicker
                isIos={isIos}
                options={durationOptions}
                fieldKey="duration"
                setValue={() => (value: string) => {
                  isNaN(Number(value)) ? field.onChange(0) : field.onChange(Number(value))
                }}
                setOpen={(value: boolean) => setOpenPicker(value ? "duration" : null)}
                isOpen={openPicker === "duration"}
                value={field.value}
                modalTitle="Duration"
              />
              {/* </View> */}
            </View>
          )}
        />

        {/* Reason is a drop down with the reason options */}
        <Controller
          control={control}
          name="reason"
          render={({ field }) => (
            <View>
              <Text preset="formLabel" tx="appointmentEditorForm:reason" />
              {/* <View style={$pickerContainer}>
                <Picker selectedValue={field.value} onValueChange={field.onChange}>
                  {reasonOptions.map((option) => (
                    <Picker.Item key={option.value} label={option.label} value={option.value} />
                  ))}
                </Picker>
              </View> */}
              <PlatformPicker
                isIos={isIos}
                options={reasonOptions}
                modalTitle="Reason"
                fieldKey="reason"
                setValue={() => (value: string) => {
                  field.onChange(value)
                }}
                setOpen={(value: boolean) => setOpenPicker(value ? "reason" : null)}
                isOpen={openPicker === "reason"}
                value={field.value}
              />
            </View>
          )}
        />

        {/* Notes is a text field */}
        <Controller
          control={control}
          name="notes"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextField
              multiline
              labelTx="appointmentEditorForm:notes"
              onChangeText={onChange}
              onBlur={onBlur}
              value={value}
            />
          )}
        />
        <Button
          onPress={handleSubmit(onSubmit)}
          disabled={isSubmitting}
          tx={isSubmitting ? "common:loading" : "common:confirm"}
        />
      </View>
    </Screen>
  )
}

const $root: ViewStyle = {
  flex: 1,
  paddingHorizontal: 14,
}

export const $pickerContainer: ViewStyle = {
  width: "100%",
  flex: 1,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  borderWidth: 1,
  borderRadius: 4,
  justifyContent: "center",
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
