import { FC, useCallback, useEffect, useState } from "react"
import { Alert, Platform, Pressable, TextStyle, ViewStyle } from "react-native"
import { withObservables } from "@nozbe/watermelondb/react"
import { catchError, of as of$ } from "rxjs"
import { Picker } from "@react-native-picker/picker"
import { NativeStackScreenProps } from "@react-navigation/native-stack"
import { format } from "date-fns"
import { upperFirst } from "es-toolkit/compat"
import { LucideCheck, LucideChevronRight, LucideEdit } from "lucide-react-native"
import DatePicker from "react-native-date-picker"
import Toast from "react-native-root-toast"

import { If } from "@/components/If"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { View } from "@/components/View"
import { useAppointment } from "@/hooks/useDBAppointment"
import { translate } from "@/i18n/translate"
import Appointment from "@/models/Appointment"
import Clinic from "@/models/Clinic"
import Event from "@/models/Event"
import Patient from "@/models/Patient"
import Visit from "@/models/Visit"
import { PatientNavigatorParamList } from "@/navigators/PatientNavigator"
import { colors } from "@/theme/colors"
import { spacing } from "@/theme/spacing"
import { useSelector } from "@xstate/react"
import { providerStore } from "@/store/provider"
import { useFocusEffect } from "@react-navigation/native"
import { usePermissionGuard } from "@/hooks/usePermissionGuard"
import { Logger } from "@hikmahealth/js-utils"

interface AppointmentViewScreenProps extends NativeStackScreenProps<
  PatientNavigatorParamList,
  "AppointmentView"
> {}

const colorCodes = ["#ffffff", "#1f2937", "#991b1b", "#c2410c", "#166534", "#1e40af", "#5b21b6"]

export const AppointmentViewScreen: FC<AppointmentViewScreenProps> = ({ route, navigation }) => {
  const { appointmentId } = route.params
  const { providerId } = useSelector(providerStore, (state) => ({ providerId: state.context.id }))

  const { can } = usePermissionGuard()
  const { appointment, patient, clinic, isLoading } = useAppointment(appointmentId)

  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false)
  const [isEditStatusOpen, setIsEditStatusOpen] = useState(false)

  const [_refreshToken, setRefreshToken] = useState<number>(Math.random())
  const refreshPage = () => {
    setRefreshToken(Math.random())
  }

  // For some reason, this page needs to be refreshed.
  useFocusEffect(
    useCallback(() => {
      refreshPage()
    }, []),
  )

  const toggleEditStatus = () => {
    setIsEditStatusOpen((state) => !state)
  }

  const openPatientFile = () => {
    if (!patient) return
    navigation.navigate("PatientView", { patientId: patient.id })
  }

  const editAppointment = () => {
    if (!validateAppointment(appointment)) return
    if (!can("appointment:update")) {
      Toast.show("You do not have permission to edit appointments", {
        position: Toast.positions.BOTTOM,
      })
      return
    }
    navigation.navigate("AppointmentEditorForm", {
      patientId: appointment.patientId,
      visitId: appointment.currentVisitId || null,
      appointmentId: appointment.id,
    })
  }

  const rescheduleAppointment = () => {
    Alert.alert(
      "Reschedule Appointment",
      "Are you sure you want to reschedule this appointment?",
      [
        { text: translate("common:cancel"), style: "cancel" },
        { text: translate("common:yes"), onPress: () => setIsDatePickerOpen(true) },
      ],
      {
        cancelable: true,
      },
    )
  }

  const handleDateChange = (date: Date) => {
    if (!validateAppointment(appointment)) return
    if (!can("appointment:update")) {
      Toast.show("You do not have permission to reschedule appointments", {
        position: Toast.positions.BOTTOM,
      })
      return
    }
    Alert.alert(
      "Reschedule Appointment",
      "Are you sure you want to reschedule this appointment to " +
        format(date, "MMM d, yyyy 'at' h:mm a") +
        "?",
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate("common:yes"),
          onPress: () => {
            Appointment.DB.update(appointment.id, { timestamp: date, status: "pending" })
              .then(() => {
                Toast.show("✅ Appointment rescheduled", {
                  position: Toast.positions.BOTTOM,
                  containerStyle: {
                    marginBottom: 100,
                  },
                })
                navigation.goBack()
              })
              .catch((err: any) => {
                Toast.show("❌ Error rescheduling appointment", {
                  position: Toast.positions.BOTTOM,
                  containerStyle: {
                    marginBottom: 100,
                  },
                })
                Logger.error(err)
              })
            setIsDatePickerOpen(false)
          },
        },
      ],
      {
        cancelable: true,
      },
    )
  }

  const handleColorChange = (color: string) => {
    let updatedMetadata: Record<string, any>

    if (!validateAppointment(appointment)) return
    if (!can("appointment:update")) {
      Toast.show("You do not have permission to update appointments", {
        position: Toast.positions.BOTTOM,
      })
      return
    }
    try {
      updatedMetadata =
        typeof appointment.metadata === "object" && appointment.metadata !== null
          ? { ...appointment.metadata, colorTag: color }
          : { colorTag: color }
    } catch (error) {
      Logger.error({ msg: "Error parsing metadata:", error })
      updatedMetadata = { colorTag: color }
    }

    Appointment.DB.update(appointment.id, {
      metadata: updatedMetadata,
    })
      .then(() => {
        Toast.show("✅ Appointment color updated", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
      })
      .catch((err) => {
        Toast.show("❌ Error updating appointment color", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
        Logger.error(err)
      })
      .finally(() => {
        refreshPage()
      })
  }

  const updateAppointmentStatus = (status: Appointment.Status) => {
    if (!validateAppointment(appointment)) return
    if (!can("appointment:update")) {
      Toast.show("You do not have permission to update appointment status", {
        position: Toast.positions.BOTTOM,
      })
      return
    }
    Appointment.DB.update(appointment.id, { status })
      .then(() => {
        Toast.show("✅ Appointment status updated", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
        setIsEditStatusOpen(false)
      })
      .catch((err) => {
        Toast.show("❌ Error updating appointment status", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
        Logger.error(err)
      })
  }

  const checkinPatient = () => {
    if (!validateAppointment(appointment)) return
    if (!can("appointment:update")) {
      Toast.show("You do not have permission to check in patients", {
        position: Toast.positions.BOTTOM,
      })
      return
    }
    Appointment.DB.update(appointment.id, { status: "checked_in" })
      .then(() => {
        Toast.show("✅ Patient checked in", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
      })
      .catch((err) => {
        Toast.show("Error checking in patient", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
        Logger.error(err)
      })
      .finally(() => {
        refreshPage()
      })
  }

  const validateAppointment = (
    appointment?: Appointment.DBAppointment | null,
  ): appointment is Appointment.DBAppointment => {
    if (!appointment) {
      Toast.show("Appointment not found", {
        position: Toast.positions.BOTTOM,
        containerStyle: {
          marginBottom: 100,
        },
      })
      return false
    }
    return true
  }

  const markAppointmentComplete = () => {
    if (!validateAppointment(appointment)) return
    if (!can("appointment:markComplete")) {
      Toast.show("You do not have permission to mark appointments as complete", {
        position: Toast.positions.BOTTOM,
      })
      return
    }
    Alert.alert(
      "Mark Appointment Complete",
      "Do you want to mark this appointment as complete?",
      [
        { text: translate("common:cancel"), style: "cancel" },
        {
          text: translate("common:yes"),
          onPress: () => {
            Appointment.DB.markComplete(appointment.id, providerId)
              .then(() => {
                Toast.show("✅ Appointment marked as complete", {
                  position: Toast.positions.BOTTOM,
                  containerStyle: {
                    marginBottom: 100,
                  },
                })
                navigation.goBack()
              })
              .catch((err) => {
                Toast.show("❌ Error marking appointment as complete", {
                  position: Toast.positions.BOTTOM,
                  containerStyle: {
                    marginBottom: 100,
                  },
                })
                Logger.error(err)
              })
          },
        },
      ],
      {
        cancelable: true,
      },
    )
  }

  const handleDepartmentOpen = (appointmentId: string) => (departmentId: string) => {
    if (!patient) {
      Toast.show("Patient not found", {
        position: Toast.positions.BOTTOM,
        containerStyle: {
          marginBottom: 100,
        },
      })
      return
    }

    navigation.navigate("NewVisit", {
      patientId: patient.id,
      visitId: null,
      visitDate: new Date().getTime(),
      appointmentId: appointmentId,
      departmentId: departmentId,
    })
  }

  const handleDepartmentStatusChange =
    (appointmentId: string) => (departmentId: string, status: DepartmentStatus) => {
      if (!appointmentId || !departmentId) {
        Toast.show("Appointment or department not found", {
          position: Toast.positions.BOTTOM,
          containerStyle: {
            marginBottom: 100,
          },
        })
        return
      }

      if (!can("appointment:update")) {
        Toast.show("You do not have permission to update department status", {
          position: Toast.positions.BOTTOM,
        })
        return
      }

      Appointment.DB.updateAppointmentDepartmentStatus(
        appointmentId,
        departmentId,
        providerId,
        status,
      )
        .then(() => {
          Toast.show(`✅ Department status updated to ${status}`, {
            position: Toast.positions.BOTTOM,
            containerStyle: {
              marginBottom: 100,
            },
          })
        })
        .catch((error) => {
          Toast.show(`Failed to update department status: ${error.message}`, {
            position: Toast.positions.BOTTOM,
            containerStyle: {
              marginBottom: 100,
            },
          })
        })
        .finally(() => {
          refreshPage()
        })
    }

  if (isLoading) {
    return (
      <Screen style={$root} preset="scroll">
        <Text text="Loading..." />
      </Screen>
    )
  }

  if (!appointment || !patient || !clinic) {
    return (
      <Screen style={$root} preset="scroll">
        <Text text="Appointment not found" />
      </Screen>
    )
  }

  return (
    <Screen style={$root} preset="scroll">
      <If condition={appointment.status === "cancelled"}>
        <View direction="row" justifyContent="space-between">
          <View style={$cancelledTopLabel}>
            <Text text="Appointment cancelled" color={colors.palette.neutral100} size="xxs" />
          </View>
        </View>
      </If>
      <Text size="xxl" text={`${Patient.displayName(patient)}`} />
      <Text
        text={`Appointment Date: \n${format(appointment.timestamp, "MMM d, yyyy 'at' h:mm a")}`}
      />
      <View direction="row" alignItems="center" gap={spacing.md} pt={spacing.xxs}>
        <Pressable onPress={openPatientFile}>
          <Text
            text="Open patient file"
            color={colors.palette.primary500}
            textDecorationLine="underline"
          />
        </Pressable>

        <Pressable onPress={editAppointment}>
          <View direction="row" alignItems="center" gap={spacing.xxs}>
            <LucideEdit color={colors.palette.primary500} size={14} />
            <Text
              tx="appointmentView:editAppointment"
              color={colors.palette.primary500}
              textDecorationLine="underline"
            />
          </View>
        </Pressable>
      </View>

      <If condition={clinic !== null && clinic !== undefined && typeof clinic.name === "string"}>
        <View pt={spacing.md}>
          <Text size="lg" text="Clinic:" />
          <Text text={clinic?.name} />
        </View>
      </If>

      <View gap={spacing.md} pt={spacing.md}>
        <View>
          <Text size="lg" text={`Status:`} />
          <If condition={isEditStatusOpen}>
            <View style={$pickerContainer}>
              <Picker
                selectedValue={appointment.status}
                onValueChange={(itemValue, _) =>
                  updateAppointmentStatus(itemValue as Appointment.Status)
                }
              >
                <Picker.Item label="Checked-in" value="checked_in" />
                <Picker.Item label="Pending" value="pending" />
                <Picker.Item label="Completed" value="completed" />
                <Picker.Item label="Cancelled" value="cancelled" />
              </Picker>
            </View>
          </If>
          <View direction="row" gap={spacing.xs} alignItems="center">
            <Text text={`${upperFirst(appointment?.status?.replace("_", " ")) || "Pending"}`} />

            <LucideEdit onPress={toggleEditStatus} color={colors.palette.primary500} size={16} />
          </View>
        </View>
        <View>
          <Text size="lg" text={`Reason:`} />
          <Text text={`${upperFirst(appointment.reason)}`} />
        </View>
        <View>
          <Text size="lg" text={`Notes:`} />
          <Text text={`${upperFirst(appointment.notes)}`} />
        </View>
      </View>

      <View gap={spacing.md} pt={spacing.md}>
        <View>
          <Text size="lg" tx={"appointmentView:colorTagLabel"} />
          <Text tx={"appointmentView:colorTagDescription"} />
        </View>
        <View>
          <View direction="row" gap={spacing.xs}>
            {colorCodes.map((color, index) => (
              <Pressable key={index} onPress={() => handleColorChange(color)}>
                <View
                  direction="row"
                  alignItems="center"
                  justifyContent="center"
                  style={[$colorCodeChip, { backgroundColor: color }]}
                >
                  <If condition={appointment?.metadata?.colorTag === color}>
                    <LucideCheck
                      color={
                        color === "#ffffff" ? colors.palette.primary400 : colors.palette.neutral100
                      }
                      size={16}
                    />
                  </If>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </View>

      <View style={$separator} my={20} />

      <Text text="Departments" size="lg" />
      <View gap={10}>
        {appointment.departments.map((department) => (
          <AppointmentDepartmentItem
            key={department.id}
            department={department}
            handleStatusChange={handleDepartmentStatusChange(appointment.id)}
            handleOpen={handleDepartmentOpen(appointment.id)}
          />
        ))}
      </View>

      <View height={100} />

      {/* TODO: Verify that this is a valid date timestamp */}
      <DatePicker
        date={new Date(appointment.timestamp)}
        mode="datetime"
        modal
        open={isDatePickerOpen}
        onConfirm={handleDateChange}
        onCancel={() => setIsDatePickerOpen(false)}
      />
    </Screen>
  )
}

type DepartmentStatus = "checked_in" | "in_progress" | "completed" | "cancelled"

const departmentStatuses: { label: string; value: DepartmentStatus }[] = [
  { label: "Checked In", value: "checked_in" },
  { label: "In Progress", value: "in_progress" },
  { label: "Completed", value: "completed" },
  { label: "Cancelled", value: "cancelled" },
]

type AppointmentDepartmentItemProps = {
  department: Appointment.EncodedDepartmentT
  handleStatusChange: (departmentId: string, status: DepartmentStatus) => void
  handleOpen: (departmentId: string) => void
}

const AppointmentDepartmentItem = ({
  department,
  handleStatusChange,
  handleOpen,
}: AppointmentDepartmentItemProps) => {
  const isCancelled = department.status === "cancelled"
  const openColor = isCancelled ? colors.palette.neutral400 : colors.palette.primary500

  return (
    <View style={$deptContainer} pb={14}>
      <View direction="row" justifyContent="space-between">
        <Text text={department.name} />

        <Pressable disabled={isCancelled} onPress={() => handleOpen(department.id)}>
          <View direction="row" alignItems="center" gap={4}>
            <Text text="Open" color={openColor} />
            <LucideChevronRight size={16} color={openColor} />
          </View>
        </Pressable>
      </View>
      <View direction="row" flexWrap="wrap" pt={14} gap={10}>
        {departmentStatuses.map((status) => (
          <Pressable
            key={status.value}
            style={$statusBtn(status.value === department.status)}
            onPress={() => handleStatusChange(department.id, status.value)}
          >
            <Text
              size="xxs"
              color={status.value === department.status ? colors.palette.neutral100 : colors.text}
              text={status.label}
            />
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const $deptContainer: ViewStyle = {
  borderBottomWidth: 1,
  borderBottomColor: colors.palette.neutral300,
}

const $statusBtn = (isSelected: boolean): ViewStyle => ({
  paddingVertical: 6,
  paddingHorizontal: 10,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.palette.neutral300,
  backgroundColor: isSelected ? colors.palette.primary500 : colors.palette.neutral100,
})

const enhanceAppointmentEvent = withObservables(["event"], ({ event }) => ({
  event,
  visit: event.visit ? event.visit.observe().pipe(catchError(() => of$(null))) : of$(null),
}))

type AppointmentEventProps = {
  appointment: Appointment.DBAppointment
  event: Event.DBEvent
  visit: Visit.DBVisit | null
  patient: Patient.DBPatient
  onPress: (visitId: string, checkInTimestamp: number) => void
}

const AppointmentEvent = enhanceAppointmentEvent(function AppointmentEvent(
  props: AppointmentEventProps,
) {
  const { event, visit, onPress, patient, appointment } = props

  if (!visit) {
    return null
  }

  return (
    <Pressable onPress={() => onPress(visit.id, appointment.timestamp)}>
      <View style={$eventContainer} direction="row" justifyContent="space-between">
        <Text text={upperFirst(event.eventType)} />
        <LucideChevronRight color={colors.palette.neutral500} size={20} />
      </View>
    </Pressable>
  )
})

const $eventContainer: ViewStyle = {
  borderBottomWidth: 1,
  borderBottomColor: colors.palette.neutral300,
  paddingVertical: spacing.xs,
}

const $root: ViewStyle = {
  flex: 1,
  padding: spacing.lg,
  backgroundColor: colors.background,
}

const $cancelledTopLabel: ViewStyle = {
  backgroundColor: colors.palette.angry500,
  padding: spacing.xxs,
  borderRadius: 4,
  width: "auto",
}

const $colorCodeChip: ViewStyle = {
  width: 32,
  height: 32,
  borderRadius: 16,
}

const $pickerContainer: ViewStyle = {
  width: "100%",
  flex: 1,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  borderWidth: 1,
  borderRadius: 4,
  justifyContent: "center",
}

const $separator: ViewStyle = {
  height: 1,
  backgroundColor: colors.palette.neutral300,
}
