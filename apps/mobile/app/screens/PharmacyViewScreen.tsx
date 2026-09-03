import { FC, useEffect, useMemo, useReducer, useState } from "react"
import { Pressable, TextStyle, ViewStyle } from "react-native"
import { LegendList } from "@legendapp/list/react-native"
import { Q } from "@nozbe/watermelondb"
import { withObservables } from "@nozbe/watermelondb/react"
import { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSelector } from "@xstate/react"
import { format, isSameDay, isToday, startOfDay } from "date-fns"
import { Option } from "effect"
import { upperFirst } from "es-toolkit"
import {
  LucideChevronDown,
  LucideChevronUp,
  LucideListTodo,
  LucideSearch,
} from "lucide-react-native"
import DropDownPicker from "react-native-dropdown-picker"
import { catchError, of as of$ } from "rxjs"

import { AgendaDateSetter } from "@/components/AgendaDateSetter"
import { FilterPanel } from "@/components/FilterPanel"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { View } from "@/components/View"
import db, { database } from "@/db"
import { useDBClinicsList } from "@/hooks/useDBClinicsList"
import {
  useDBPrescriptionsFilter,
  type PrescriptionsFilters,
} from "@/hooks/useDBPrescriptionsFilter"
import Clinic from "@/models/Clinic"
import DrugCatalogue from "@/models/DrugCatalogue"
import Patient from "@/models/Patient"
import Prescription from "@/models/Prescription"
import { PharmacyNavigatorParamList } from "@/navigators/PharmacyNavigator"
// import { useNavigation } from "@react-navigation/native"

import { providerStore } from "@/store/provider"
import { colors } from "@/theme/colors"
import { useAppTheme } from "@/theme/context"
import { ThemedStyle } from "@/theme/types"
import { describePrescriptionFilters } from "@/utils/filterChips"
import { friendlyString, getPrescriptionStatusColor, toggleStringInArray } from "@/utils/misc"
import { useSafeAreaInsetsStyle } from "@/utils/useSafeAreaInsetsStyle"
import { If } from "@/components/If"

interface PharmacyViewScreenProps extends NativeStackScreenProps<
  PharmacyNavigatorParamList,
  "PharmacyView"
> {}

export const PharmacyViewScreen: FC<PharmacyViewScreenProps> = ({ route, navigation }) => {
  const { theme } = useAppTheme()

  const {
    id: providerId,
    clinic_id,
    clinic_name,
    name: providerName,
  } = useSelector(providerStore, (state) => state.context)
  const propsClinicId = Option.getOrElse(clinic_id, () => "")

  const { clinics: clinicsList, isLoading: isLoadingClinics } = useDBClinicsList()

  const { groups, isTruncated, clearFilters, filters, handleFiltersChange, loadMore } =
    useDBPrescriptionsFilter(propsClinicId, clinicsList)

  // Only groups the user explicitly toggled; absent means "use the default",
  // so a group appearing later does not inherit a stale entry.
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({})

  const toggleGroup = (patientId: string, isOpen: boolean) => {
    setOpenOverrides((previous) => ({ ...previous, [patientId]: !isOpen }))
  }

  // A change to any filter is a different set of groups, so overrides reset —
  // including when the day turns over on its own.
  const filtersKey = `${filters.status}_${filters.clinicId}_${filters.country}_${filters.city}_${filters.searchQuery}__${filters.date.toDateString()}`

  useEffect(() => {
    setOpenOverrides((previous) => (Object.keys(previous).length === 0 ? previous : {}))
  }, [filtersKey])

  const handlePrescriptionPress = (prescription: Prescription.T) => {
    navigation.navigate("PrescriptionView", {
      prescriptionId: prescription.id,
      // visitId: prescription.visit_id,
    })
  }

  if (isLoadingClinics) {
    return (
      <View style={$root}>
        <Text>Loading Clinics...</Text>
      </View>
    )
  }

  // LegendList memoizes rows against extraData, so open state has to be in it.
  const openOverridesKey = Object.entries(openOverrides)
    .map(([patientId, isOpen]) => `${patientId}:${isOpen ? 1 : 0}`)
    .join("|")

  return (
    <LegendList
      ListHeaderComponent={
        <PrescriptionsListHeader
          clinicsList={clinicsList}
          defaultClinicId={propsClinicId}
          clearFilters={clearFilters}
          filters={filters}
          onFiltersChange={handleFiltersChange}
        />
      }
      // ItemSeparatorComponent={ItemSeparatorComponent}
      data={groups}
      // data={[]}
      renderItem={({ item }) => {
        const isOpen = openOverrides[item.patientId] ?? isOpenByDefault(item)
        return (
          <View px={10}>
            <PatientPrescriptionsGroup
              group={item}
              patientId={item.patientId}
              isOpen={isOpen}
              onToggle={() => toggleGroup(item.patientId, isOpen)}
              onPrescriptionPress={handlePrescriptionPress}
            />
          </View>
        )
      }}
      recycleItems={false}
      // Re-render groups if a prescription status changes
      keyExtractor={(item) => `${item.patientId}_${groupRevision(item)}`}
      ListEmptyComponent={
        <View justifyContent="center" px={10} alignItems="center" pt={"40%"}>
          <LucideListTodo size={120} color={theme.colors.textDim} />
          <Text text="No prescriptions found" size="xl" />
        </View>
      }
      ListFooterComponent={
        <View mb={64} px={10} pt={10}>
          {isTruncated && (
            <Text
              testID="pharmacy-prescriptions-truncated"
              text="Too many prescriptions for this day to show them all. Narrow the filters to see the rest."
              size="xxs"
              color={theme.colors.textDim}
            />
          )}
        </View>
      }
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
      extraData={`${filtersKey}__${openOverridesKey}`}
    />
  )
}

/** A single prescription has nothing to summarise, so it opens. */
const isOpenByDefault = (group: Prescription.PatientGroup): boolean =>
  group.prescriptions.length === 1

/** Changes whenever the group's membership or any of its prescriptions change. */
const groupRevision = (group: Prescription.PatientGroup): string => {
  let latestUpdateMs = 0
  for (const prescription of group.prescriptions) {
    latestUpdateMs = Math.max(latestUpdateMs, prescription.updatedAt?.getTime() ?? 0)
  }
  return `${group.prescriptions.length}_${latestUpdateMs}`
}

type PrescriptionListHeaderProps = {
  clinicsList: Clinic.DBClinic[]
  /** The provider's own clinic — the default scope, so never shown as a chip. */
  defaultClinicId: string
  clearFilters: () => void
  filters: PrescriptionsFilters
  onFiltersChange: (filters: Partial<PrescriptionsFilters>) => void
}

const statusesList = Prescription.statusList

const PrescriptionsListHeader: FC<PrescriptionListHeaderProps> = ({
  clinicsList,
  defaultClinicId,
  clearFilters,
  filters,
  onFiltersChange,
}: PrescriptionListHeaderProps) => {
  const { themed } = useAppTheme()
  const { paddingTop: safeAreaPaddingTop } = useSafeAreaInsetsStyle(["top"])
  const [openDropdown, setOpenDropdown] = useState<
    "clinic" | "status" | "department" | "country" | "city" | null
  >(null)

  const countryOptions = useMemo(() => Clinic.countryOptions(clinicsList), [clinicsList])
  const cityOptions = useMemo(
    () => Clinic.cityOptions(clinicsList, filters.country),
    [clinicsList, filters.country],
  )
  // The "All …" entry matches the unset value, so leaving it in an otherwise
  // empty list would mask the placeholder explaining why there is nothing.
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
      describePrescriptionFilters(filters, {
        clinics: clinicsList,
        defaultClinicId,
      }).map((chip) => ({
        key: chip.key,
        label: chip.label,
        onRemove: () => onFiltersChange(chip.clear),
      })),
    [filters, clinicsList, defaultClinicId, onFiltersChange],
  )

  return (
    <View style={themed($headerContainer)}>
      {/* Search Bar */}
      <TextField
        testID="pharmacy-search-prescriptions"
        placeholder="Search prescriptions..."
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
              { paddingTop: safeAreaPaddingTop },
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
              { paddingTop: safeAreaPaddingTop },
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
            zIndex={990000}
            modalContentContainerStyle={[
              $modalContentContainerStyle,
              { paddingTop: safeAreaPaddingTop },
            ]}
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
          <Text preset="formLabel" text="Status" />

          <View direction="row" flexWrap="wrap" gap={5}>
            {statusesList.map((status) => (
              <Pressable
                style={[$statusChip, filters.status.includes(status) ? $statusChipActive : null]}
                key={status}
                onPress={() => {
                  onFiltersChange({
                    status: toggleStringInArray(status, filters.status) as Prescription.Status[],
                  })
                }}
              >
                <Text
                  style={[
                    filters.status.includes(status) ? $statusChipActiveText : $statusChipText,
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

      <AgendaDateSetter date={filters.date} setDate={(date) => onFiltersChange({ date })} />
    </View>
  )
}

// Keyed on `patientId` rather than `group`: grouping mints a fresh group object
// on every emit, which would resubscribe the patient each time.
const enhancePatientGroup = withObservables(
  ["patientId"],
  ({ patientId }: { patientId: string }) => ({
    patient: db
      .get<Patient.DB.T>("patients")
      .findAndObserve(patientId)
      .pipe(catchError(() => of$(null))),
  }),
)

/** One patient's prescriptions for the day, behind a name/count/status header. */
const PatientPrescriptionsGroup = enhancePatientGroup(
  ({
    group,
    patient,
    isOpen,
    onToggle,
    onPrescriptionPress,
  }: {
    group: Prescription.PatientGroup
    patientId: string
    patient: Patient.DB.T | null
    isOpen: boolean
    onToggle: () => void
    onPrescriptionPress: (prescription: Prescription.T) => void
  }) => {
    const { theme, themed } = useAppTheme()
    const Chevron = isOpen ? LucideChevronUp : LucideChevronDown

    const priorityPrescriptions = group.prescriptions.filter(
      (it) =>
        ["pending", "prepared"].includes(it.status) &&
        (it.priority === "high" || it.priority === "emergency"),
    )

    // A prescription can outlive its patient row, and reading a name off
    // nothing would take down the whole group.
    const title = patient ? Patient.displayName(patient) : "Patient does not exist anymore."

    return (
      <View style={themed($patientGroup)}>
        <Pressable testID={`pharmacy-patient-group-${group.patientId}`} onPress={onToggle}>
          <View direction="row" alignItems="center" gap={8} px={16} py={12}>
            <Chevron size={20} color={theme.colors.textDim} />

            <View flex={1}>
              <Text testID={`pharmacy-patient-name-${group.patientId}`} text={title} size={"lg"} />
              <If condition={priorityPrescriptions.length > 0}>
                <View flex={1} direction="row">
                  <View style={$highPriorityBadge}>
                    <Text size="xxs" text={`High Priority Prescription`} />
                  </View>
                </View>
              </If>
              <Text
                testID={`pharmacy-patient-status-summary-${group.patientId}`}
                text={Prescription.describeStatusCounts(group.statusCounts)}
                size={"xxs"}
                color={theme.colors.textDim}
              />
            </View>

            <View
              testID={`pharmacy-patient-prescription-count-${group.patientId}`}
              style={themed($countBadge)}
            >
              <Text text={String(group.prescriptions.length)} size={"xs"} />
            </View>
          </View>
        </Pressable>

        {isOpen &&
          group.prescriptions.map((prescription) => (
            <PrescriptionListItem
              key={prescription.id}
              prescription={prescription}
              onPress={() => onPrescriptionPress(prescription)}
            />
          ))}
      </View>
    )
  },
)

const enhance = withObservables(
  ["prescription"],
  ({ prescription }: { prescription: Prescription.T }) => ({
    prescription: db
      .get<Prescription.DB.T>("prescriptions")
      .findAndObserve(prescription.id)
      .pipe(catchError(() => of$(null))),
  }),
)

const PrescriptionListItem = enhance(
  ({ prescription, onPress }: { prescription: Prescription.DB.T | null; onPress: () => void }) => {
    const { themed } = useAppTheme()

    const [prescribedDrugs, setPrescribedDrugs] = useState<DrugCatalogue.DB.T[]>([])
    const prescriptionId = prescription?.id

    useEffect(() => {
      if (!prescriptionId) return

      const sub = database
        .get<DrugCatalogue.DB.T>(DrugCatalogue.DB.table_name)
        .query(Q.on("prescription_items", "prescription_id", prescriptionId))
        .observe()
        .subscribe((drugs) => {
          setPrescribedDrugs(drugs)
        })

      return () => {
        sub.unsubscribe()
      }
    }, [prescriptionId])

    if (!prescription) {
      return (
        <View>
          <Text text="Prescription does not exist anymore." />
        </View>
      )
    }

    const [backgroundColor, textColor] = getPrescriptionStatusColor(prescription.status)

    return (
      <Pressable testID={`pharmacy-prescription-item-${prescription.id}`} onPress={onPress}>
        <View style={themed($prescriptionListItem)}>
          <View direction="row" py={2}>
            <View
              testID={`pharmacy-prescription-status-${prescription.id}`}
              style={
                (themed($statusBadge),
                {
                  borderColor: backgroundColor,
                  backgroundColor,
                  paddingHorizontal: 6,
                  borderRadius: 8,
                })
              }
            >
              <Text
                testID={`pharmacy-prescription-status-text-${prescription.id}`}
                text={prescription.status}
                size={"xxs"}
                color={textColor}
              />
            </View>
          </View>

          {prescribedDrugs.map((drug) => (
            <View key={drug.id} mb={10} testID={`pharmacy-prescription-drug-${drug.id}`}>
              <Text
                testID={`pharmacy-prescription-drug-name-${drug.id}`}
                size={"xs"}
                text={DrugCatalogue.displayName(drug)}
              />
              <Text size={"xxs"}>
                {friendlyString(drug.form)} {drug.dosageQuantity}
                {drug.dosageUnits} {drug.route}
              </Text>
              <Text size={"xxs"}>Priority: {prescription.priority}</Text>
            </View>
          ))}
        </View>
      </Pressable>
    )
  },
)

const $statusBadge: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  // paddingVertical: spacing.xs,
  paddingHorizontal: spacing.xs,
  borderColor: colors.palette.primary500,
  borderWidth: 1,
  borderRadius: 8,
})

const $prescriptionListItem: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  paddingVertical: spacing.md,
  paddingHorizontal: spacing.md,
  backgroundColor: colors.palette.neutral200,
  borderTopWidth: 1,
  borderTopColor: colors.border,
})

const $patientGroup: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  marginBottom: spacing.sm,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 8,
  backgroundColor: colors.palette.neutral200,
  overflow: "hidden",
})

const $countBadge: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  minWidth: 28,
  alignItems: "center",
  paddingVertical: 2,
  paddingHorizontal: spacing.xs,
  borderRadius: 12,
  backgroundColor: colors.palette.neutral300,
})

const $root: ViewStyle = {
  flex: 1,
  paddingHorizontal: 14,
}

const $headerContainer: ThemedStyle<ViewStyle> = ({ spacing, colors }) => ({
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.md,
  paddingTop: spacing.xl,
  backgroundColor: colors.background,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
  marginBottom: spacing.md,
})

const $searchField: ViewStyle = {
  marginBottom: 12,
}

const $searchIcon: ViewStyle = {
  marginRight: 8,
  alignSelf: "center",
}

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

const $highPriorityBadge: ViewStyle = {
  paddingVertical: 4,
  paddingHorizontal: 8,
  borderRadius: 10,
  backgroundColor: colors.palette.accent500,
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

const $modalContentContainerStyle: ViewStyle = {
  marginTop: 4,
  borderWidth: 1,
  borderRadius: 4,
  backgroundColor: colors.palette.neutral200,
  borderColor: colors.palette.neutral400,
  zIndex: 990000,
  flex: 1,
}
