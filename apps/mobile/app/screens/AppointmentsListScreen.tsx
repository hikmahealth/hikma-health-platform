import { FC, useMemo, useState, useEffect, useCallback } from "react"
import { ViewStyle, TextStyle, Pressable } from "react-native"
import { LegendList } from "@legendapp/list/react-native"
import { Q } from "@nozbe/watermelondb"
import { compose } from "@nozbe/watermelondb/react"
import withObservables from "@nozbe/watermelondb/react/withObservables"
import { useFocusEffect } from "@react-navigation/native"
import type { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSelector } from "@xstate/react"
import { format, isSameDay, isToday, startOfDay } from "date-fns"
import { Option } from "effect"
import { upperFirst } from "es-toolkit"
import {
  LucideCheck,
  LucideChevronDown,
  LucideChevronUp,
  LucideListTodo,
  LucideSearch,
} from "lucide-react-native"
import DropDownPicker from "react-native-dropdown-picker"
import { catchError, of as of$ } from "rxjs"
import { useDebounceValue } from "usehooks-ts"

import { AgendaDateSetter } from "@/components/AgendaDateSetter"
import { FilterPanel } from "@/components/FilterPanel"
import { If } from "@/components/If"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { View } from "@/components/View"
import db from "@/db"
import ClinicDepartmentModel from "@/db/model/ClinicDepartment"
import { AppointmentsFilters, useDBAppointmentsFilter } from "@/hooks/useDBAppointmentsFilter"
import { useDBClinicsList } from "@/hooks/useDBClinicsList"
import Appointment from "@/models/Appointment"
import Clinic from "@/models/Clinic"
import Patient from "@/models/Patient"
import type { AppointmentNavigatorParamList } from "@/navigators/AppointmentNavigator"
import { providerStore } from "@/store/provider"
import { colors } from "@/theme/colors"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"
import { describeAppointmentFilters } from "@/utils/filterChips"
import { friendlyString, getAppintmentStatusColor } from "@/utils/misc"
import { useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"

interface AppointmentsListScreenProps extends NativeStackScreenProps<
  AppointmentNavigatorParamList,
  "AppointmentsList"
> {}

export const AppointmentsListScreen: FC<AppointmentsListScreenProps> = ({ navigation }) => {
  const { themed } = useAppTheme()
  const {
    id: providerId,
    clinic_id,
    clinic_name,
    name: providerName,
  } = useSelector(providerStore, (state) => state.context)
  const propsClinicId = Option.getOrElse(clinic_id, () => "")

  const { clinics: clinicsList, isLoading: isLoadingClinics } = useDBClinicsList()

  const { appointments, clearFilters, filters, handleFiltersChange, loadMore, summary } =
    useDBAppointmentsFilter(propsClinicId, clinicsList)

  const activeClinic = clinicsList.find((clinic) => clinic.id === filters.clinicId)

  const handleAppointmentPress = (appointment: { patientId: string; id: string }) => {
    if (!appointment.patientId) return
    navigation.navigate("AppointmentView", {
      patientId: appointment.patientId,
      appointmentId: appointment.id,
    })
  }

  if (isLoadingClinics) {
    return (
      <View style={$root}>
        <Text>Loading Clinics...</Text>
      </View>
    )
  }

  return (
    <LegendList
      ListHeaderComponent={
        <AppointmentListHeader
          clinicsList={clinicsList}
          clinic={activeClinic}
          defaultClinicId={propsClinicId}
          clearFilters={clearFilters}
          filters={filters}
          onFiltersChange={handleFiltersChange}
          summary={summary}
        />
      }
      data={appointments}
      renderItem={({ item }) => {
        return (
          <View px={10}>
            <AppointmentItem onPress={() => handleAppointmentPress(item)} appointment={item} />
          </View>
        )
      }}
      recycleItems={false}
      // Re-render items if the appointment status changes
      keyExtractor={(item) => `${item.id}_${item.updatedAt}`}
      ListEmptyComponent={
        <View justifyContent="center" px={10} alignItems="center" pt={"40%"}>
          <LucideListTodo size={120} color={colors.textDim} />
          <Text text="No appointments found" size="xl" />
        </View>
      }
      ListFooterComponent={<View mb={64}></View>}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      extraData={`${filters.status}_${filters.clinicId}_${filters.country}_${filters.city}_${filters.searchQuery}__${filters.date.toDateString()}__${filters.departmentIds}`}
    />
  )
}

interface AppointmentListHeaderProps {
  clinicsList: Clinic.DBClinic[]
  clinic?: Clinic.DBClinic
  /** The provider's own clinic — the default scope, so never shown as a chip. */
  defaultClinicId: string
  filters: AppointmentsFilters
  clearFilters: () => void
  onFiltersChange: (filters: Partial<AppointmentsFilters>) => void
  /** Counts across every status, so it stays informative while a status filter is applied. */
  summary: Appointment.StatusSummary | null
}

const enhanceHeader = withObservables(["clinic"], ({ clinic }: { clinic?: Clinic.DBClinic }) => ({
  clinic: clinic ? clinic.observe().pipe(catchError(() => of$(null))) : of$(null),
  departmentList: clinic
    ? db
        .get<ClinicDepartmentModel>("clinic_departments")
        .query(Q.where("clinic_id", clinic.id))
        .observe()
        .pipe(catchError(() => of$([])))
    : of$([]),
}))

const statusesList = Appointment.statusList

export const AppointmentListHeader: FC<AppointmentListHeaderProps> = enhanceHeader(
  ({
    filters,
    clearFilters,
    onFiltersChange,
    departmentList = [],
    clinicsList,
    defaultClinicId,
    summary,
  }: {
    filters: AppointmentsFilters
    clearFilters: () => void
    onFiltersChange: (filters: Partial<AppointmentsFilters>) => void
    departmentList: ClinicDepartmentModel[]
    clinicsList: Clinic.DBClinic[]
    defaultClinicId: string
    summary: Appointment.StatusSummary | null
  }) => {
    const { themed } = useAppTheme()
    const [openDropdown, setOpenDropdown] = useState<
      "clinic" | "status" | "department" | "country" | "city" | null
    >(null)
    const { paddingTop: safeAreaPaddingTop, paddingBottom: safeAreaPaddingBottom } =
      useSafeAreaInsetsStyle(["top", "bottom"])

    const countryOptions = useMemo(() => Clinic.countryOptions(clinicsList), [clinicsList])
    const cityOptions = useMemo(
      () => Clinic.cityOptions(clinicsList, filters.country),
      [clinicsList, filters.country],
    )
    // The "All …" entry matches the unset value, so leaving it in an otherwise
    // empty list would mask the placeholder that explains why there is nothing.
    const countryItems = useMemo(
      () =>
        countryOptions.length === 0
          ? []
          : [
              { label: "All countries", value: "" },
              ...countryOptions.map((country) => ({ label: country, value: country })),
            ],
      [countryOptions],
    )
    const cityItems = useMemo(
      () =>
        cityOptions.length === 0
          ? []
          : [
              { label: "All cities", value: "" },
              ...cityOptions.map((city) => ({ label: city, value: city })),
            ],
      [cityOptions],
    )
    const clinicOptions = useMemo(
      () => Clinic.clinicsIn(clinicsList, filters.country, filters.city),
      [clinicsList, filters.country, filters.city],
    )

    const chips = useMemo(
      () =>
        describeAppointmentFilters(filters, {
          clinics: clinicsList,
          departments: departmentList,
          defaultClinicId,
        }).map((chip) => ({
          key: chip.key,
          label: chip.label,
          onRemove: () => onFiltersChange(chip.clear),
        })),
      [filters, clinicsList, departmentList, defaultClinicId, onFiltersChange],
    )

    return (
      <View style={themed($headerContainer)}>
        <TextField
          placeholder="Search appointments..."
          value={filters.searchQuery}
          onChangeText={(text) => onFiltersChange({ searchQuery: text })}
          style={$searchField}
          // TODO: Center the icon and add right side padding
          RightAccessory={() => <LucideSearch style={$searchIcon} />}
        />

        <FilterPanel chips={chips} onClearAll={clearFilters}>
          <View mt={10}>
            <Text preset="formLabel" text="Country" />

            <DropDownPicker
              open={openDropdown === "country"}
              setOpen={(open) => {
                if (open as unknown as boolean) setOpenDropdown("country")
                else setOpenDropdown(null)
              }}
              modalTitle="Country"
              style={$dropDownPickerStyle}
              modalContentContainerStyle={[
                $modalContentContainerStyle,
                { paddingTop: safeAreaPaddingTop, marginBottom: safeAreaPaddingBottom },
              ]}
              zIndex={990000}
              zIndexInverse={990000}
              listMode="MODAL"
              disabled={countryOptions.length === 0}
              disabledStyle={$dropDownPickerDisabledStyle}
              placeholder={
                countryOptions.length === 0 ? "No clinics have a country set" : "All countries"
              }
              items={countryItems}
              value={filters.country}
              setValue={(cb) => {
                const data = cb(filters.country)
                onFiltersChange({ country: data })
              }}
            />
          </View>

          <View mt={10}>
            <Text preset="formLabel" text="City" />

            <DropDownPicker
              open={openDropdown === "city"}
              setOpen={(open) => {
                if (open as unknown as boolean) setOpenDropdown("city")
                else setOpenDropdown(null)
              }}
              modalTitle="City"
              style={$dropDownPickerStyle}
              modalContentContainerStyle={[
                $modalContentContainerStyle,
                { paddingTop: safeAreaPaddingTop, marginBottom: safeAreaPaddingBottom },
              ]}
              zIndex={990000}
              zIndexInverse={990000}
              listMode="MODAL"
              disabled={cityOptions.length === 0}
              disabledStyle={$dropDownPickerDisabledStyle}
              placeholder={cityOptions.length === 0 ? "No clinics have a city set" : "All cities"}
              items={cityItems}
              value={filters.city}
              setValue={(cb) => {
                const data = cb(filters.city)
                onFiltersChange({ city: data })
              }}
            />
          </View>

          <View mt={10}>
            <Text preset="formLabel" text="Clinic" />

            <DropDownPicker
              open={openDropdown === "clinic"}
              setOpen={(open) => {
                if (open as unknown as boolean) setOpenDropdown("clinic")
                else setOpenDropdown(null)
              }}
              modalTitle="Clinic"
              style={$dropDownPickerStyle}
              modalContentContainerStyle={[
                $modalContentContainerStyle,
                { paddingTop: safeAreaPaddingTop, marginBottom: safeAreaPaddingBottom },
              ]}
              zIndex={990000}
              zIndexInverse={990000}
              listMode="MODAL"
              items={[
                { label: "All clinics", value: "" },
                ...clinicOptions.map((clinic) => ({
                  label: clinic.name,
                  value: clinic.id,
                })),
              ]}
              value={filters.clinicId || ""}
              setValue={(cb) => {
                const data = cb(filters.clinicId)
                onFiltersChange({ clinicId: data })
              }}
            />
          </View>

          <View mt={10}>
            <Text preset="formLabel" text="Department" />

            <DropDownPicker
              open={openDropdown === "department"}
              setOpen={(open) => {
                if (open as unknown as boolean) setOpenDropdown("department")
                else setOpenDropdown(null)
              }}
              modalTitle="Department"
              style={$dropDownPickerStyle}
              zIndex={990000}
              zIndexInverse={990000}
              listMode="MODAL"
              modalContentContainerStyle={[
                $modalContentContainerStyle,
                { paddingTop: safeAreaPaddingTop, marginBottom: safeAreaPaddingBottom },
              ]}
              items={departmentList.map((department) => ({
                label: department.name,
                value: department.id,
              }))}
              mode="BADGE"
              multiple
              value={filters.departmentIds || ""}
              onSelectItem={(items) => {
                const data = items.map((item) => item.value).filter(Boolean)
                onFiltersChange({ departmentIds: data })
              }}
            />
          </View>

          <View mt={10}>
            <Text preset="formLabel" text="Status" />

            <View direction="row" flexWrap="wrap" gap={5}>
              {statusesList.map((status) => (
                <Pressable
                  style={[$statusChip, status === filters.status ? $statusChipActive : null]}
                  key={status}
                  onPress={() => {
                    onFiltersChange({ status: status })
                  }}
                >
                  <Text
                    style={[
                      status === filters.status ? $statusChipActiveText : $statusChipText,
                      null,
                    ]}
                    size="xxs"
                  >
                    {upperFirst(status.replaceAll("_", " "))}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </FilterPanel>
        <View>
          <AgendaDateSetter date={filters.date} setDate={(date) => onFiltersChange({ date })} />
        </View>
        {summary && summary.total > 0 ? (
          <View pt={6} direction="row" flexWrap="wrap" alignItems="center" gap={10}>
            <Text size="xxs" style={themed($summaryTotalText)} text={`Total ${summary.total}`} />
            {statusesList.map((status) => (
              <StatusCount
                key={status}
                label={upperFirst(status.replaceAll("_", " "))}
                color={getAppintmentStatusColor(status)[0]}
                count={summary.byStatus[status]}
              />
            ))}
            {summary.unrecognized > 0 ? (
              <StatusCount label="Other" color={colors.textDim} count={summary.unrecognized} />
            ) : null}
          </View>
        ) : null}
      </View>
    )
  },
)

/** One entry of the status legend under the date setter. Dimmed when nothing is in that status. */
const StatusCount: FC<{ label: string; color: string; count: number }> = ({
  label,
  color,
  count,
}) => {
  const { themed } = useAppTheme()

  return (
    <View
      direction="row"
      alignItems="center"
      gap={4}
      style={count === 0 ? $summaryItemEmpty : null}
    >
      <View style={[$summaryDot, { backgroundColor: color }]} />
      <Text size="xxs" style={themed($summaryText)} text={`${label} ${count}`} />
    </View>
  )
}

const $container: ViewStyle = {
  justifyContent: "center",
}

const $text: ThemedStyle<TextStyle> = ({ colors, typography }) => ({
  fontFamily: typography.primary.normal,
  fontSize: 14,
  color: colors.palette.primary500,
})

// Resolve the appointment, then its patient and clinic, onto the item's props
const enhance = compose(
  withObservables(["appointment"], ({ appointment }: { appointment: Appointment.T }) => ({
    appointment: db
      .get("appointments")
      .findAndObserve(appointment.id)
      .pipe(catchError(() => of$(null))),
  })),
  // `appointment.patient` is a Relation object, which exists even when the patient doesn't - so
  // test the foreign key instead. observe() then still errors if the key points at a row that
  // hasn't synced yet, and an unhandled error here takes down the whole list.
  withObservables(
    ["appointment"],
    ({ appointment }: { appointment: Appointment.DBAppointment }) => ({
      patient:
        appointment?.patientId && appointment.patient
          ? appointment.patient.observe().pipe(catchError(() => of$(null)))
          : of$(null),
      clinic:
        appointment?.clinicId && appointment.clinic
          ? appointment.clinic.observe().pipe(catchError(() => of$(null)))
          : of$(null),
    }),
  ),
)

const AppointmentItem = enhance(
  ({
    appointment,
    patient,
    clinic,
    onPress,
  }: {
    appointment: Appointment.DBAppointment
    patient: Patient.DBPatient | null | undefined
    clinic: Clinic.DBClinic | null | undefined
    onPress: () => void
  }) => {
    const { themed } = useAppTheme()

    if (!appointment) {
      return (
        <View>
          <Text text="No Appointment" size="md" />
        </View>
      )
    }

    return (
      <Pressable onPress={onPress}>
        <View style={$appointmentListItem}>
          <View direction="row" justifyContent="space-between">
            <View direction="row" alignItems="baseline" gap={4}>
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 100,
                  backgroundColor: appointment.metadata?.colorTag || colors.palette.neutral100,
                }}
              />
              <Text
                text={patient ? upperFirst(Patient.displayName(patient as any)) : ""}
                size="md"
              />
            </View>
            <View style={{}}>
              <Text
                color={colors.palette.primary500}
                text={appointment?.status?.replace("_", " ") || "Pending"}
                size="xxs"
              />
            </View>
          </View>
          <If condition={!!clinic && clinic.name !== undefined}>
            <Text
              color={colors.palette.primary500}
              textDecorationLine="underline"
              text={clinic?.name || ""}
              size="xs"
            />
          </If>
          <Text text={`Time: ${format(appointment.timestamp, "h:mm a")}`} size="xs" />
          <Text text={`Created at ${format(appointment.createdAt, "MMM dd, h:mm a")}`} size="xs" />
          <If condition={appointment?.departments?.length > 0}>
            <View pt={4}>
              <Text text="Departments:" size="xs" textDecorationLine="underline" />
              <View direction="column">
                {appointment?.departments?.map((department) => (
                  <View key={department.id} direction="row" alignItems="center" gap={4}>
                    <Text text={department.name} size="xs" />
                    <Text>-</Text>
                    <View
                      style={{
                        backgroundColor: getAppintmentStatusColor(department.status)[0],
                        alignSelf: "center",
                      }}
                      py={2}
                      px={4}
                      height={10}
                      width={10}
                      borderRadius={5}
                    />
                    <Text text={friendlyString(department.status)} size="xs" />
                  </View>
                ))}
              </View>
            </View>
          </If>
        </View>
      </Pressable>
    )
  },
)

// TODO: move this to a single shared location across files
const $dropDownPickerStyle: ViewStyle = {
  marginTop: 2,
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  zIndex: 990000,
  flex: 1,
}

const $dropDownPickerDisabledStyle: ViewStyle = {
  opacity: 0.5,
}

const $statusChip: ViewStyle = {
  paddingVertical: 4,
  paddingHorizontal: 8,
  borderRadius: 10,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  borderWidth: 1,
}

const $statusChipText: TextStyle = {
  color: colors.palette.neutral800,
}

const $statusChipActive: ViewStyle = {
  backgroundColor: colors.palette.primary500,
  borderColor: colors.palette.primary500,
}

const $statusChipActiveText: TextStyle = {
  color: colors.palette.neutral100,
}

const $appointmentListItem: ViewStyle = {
  padding: 8,
  borderBottomWidth: 1,
  borderBottomColor: "#ccc",
  marginHorizontal: 10,
  marginVertical: 5,
  marginBottom: 10,
}

export const ItemSeparatorComponent = () => {
  const { themed } = useAppTheme()
  return <View style={themed($separator)} />
}

const $root: ViewStyle = {
  flex: 1,
}

const $headerContainer: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.md,
  paddingTop: spacing.xl,
  backgroundColor: colors.background,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
})

const $searchField: ViewStyle = {
  marginBottom: 12,
}

const $searchIcon: ViewStyle = {
  marginRight: 8,
  alignSelf: "center",
}

const $filterToggleButton: ViewStyle = {
  flex: 1,
  marginRight: 8,
}

const $filterToggleIcon: ViewStyle = {
  marginLeft: 4,
}

const $separator: ThemedStyle<ViewStyle> = ({ colors }) => ({
  height: 1,
  backgroundColor: colors.border,
})

const $emptySubtext: ThemedStyle<TextStyle> = ({ colors }) => ({
  color: colors.textDim,
  marginTop: 8,
})

const $summaryText: ThemedStyle<TextStyle> = ({ colors }) => ({
  color: colors.textDim,
})

const $summaryTotalText: ThemedStyle<TextStyle> = ({ colors }) => ({
  color: colors.text,
})

const $summaryItemEmpty: ViewStyle = {
  opacity: 0.45,
}

const $summaryDot: ViewStyle = {
  width: 6,
  height: 6,
  borderRadius: 3,
}

const $modalContentContainerStyle: ViewStyle = {
  marginTop: 4,
  // marginBottom: 40,
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  zIndex: 990000,
  flex: 1,
}
