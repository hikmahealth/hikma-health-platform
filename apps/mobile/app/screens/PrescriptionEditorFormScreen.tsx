import { FC, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { BackHandler, Platform, Pressable, ViewStyle } from "react-native"
import {
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet"
import { Database, Q } from "@nozbe/watermelondb"
import { sanitizeLikeString } from "@nozbe/watermelondb/QueryDescription"
import { withObservables } from "@nozbe/watermelondb/react"
import { useFocusEffect } from "@react-navigation/native"
import { NativeStackScreenProps } from "@react-navigation/native-stack"
import { useSelector } from "@xstate/react"
import { Option } from "effect"
import { groupBy, sortBy, upperFirst } from "es-toolkit"
import { LucidePlus, LucideX } from "lucide-react-native"
import { Controller, useForm } from "react-hook-form"
import Toast from "react-native-root-toast"
import { catchError, of as of$ } from "rxjs"
import { useDebounceValue } from "usehooks-ts"
import { v1 as uuidV1 } from "uuid"

import { Button } from "@/components/Button"
import { If } from "@/components/If"
import { PlatformPicker } from "@/components/PlatformPicker"
import { Screen } from "@/components/Screen"
import { Text } from "@/components/Text"
import { TextField } from "@/components/TextField"
import { Checkbox } from "@/components/Toggle/Checkbox"
import { Radio } from "@/components/Toggle/Radio"
import { View } from "@/components/View"
import database from "@/db"
import { useDBClinicsList } from "@/hooks/useDBClinicsList"
import { usePatientRecord } from "@/hooks/usePatientRecord"
import { usePermissionGuard } from "@/hooks/usePermissionGuard"
import ClinicInventory from "@/models/ClinicInventory"
import DrugCatalogue from "@/models/DrugCatalogue"
import Patient from "@/models/Patient"
import Prescription from "@/models/Prescription"
import PrescriptionItem from "@/models/PrescriptionItem"
import { PharmacyNavigatorParamList } from "@/navigators/PharmacyNavigator"
import { providerStore } from "@/store/provider"
import { useAppTheme } from "@/theme/context"
import { ThemedStyle } from "@/theme/types"
import { calculateAge } from "@/utils/date"
import { friendlyString } from "@/utils/misc"
import { Logger } from "@hikmahealth/js-utils"

interface PrescriptionEditorFormScreenProps extends NativeStackScreenProps<
  PharmacyNavigatorParamList,
  "PrescriptionEditorForm"
> {}

export const PrescriptionEditorFormScreen: FC<PrescriptionEditorFormScreenProps> = ({
  route,
  navigation,
}) => {
  const {
    id: providerId,
    clinic_name,
    clinic_id,
    name: providerName,
  } = useSelector(providerStore, (state) => state.context)
  const { theme } = useAppTheme()
  const { can, checkEditPrescription, isLoading: isLoadingPermissions } = usePermissionGuard()

  const providerClinicId = Option.getOrUndefined(clinic_id)

  const { patientId, visitId, prescriptionId, shouldCreateNewVisit = true } = route.params

  const isEditing = Boolean(prescriptionId)
  // An edit already has a visit; letting the save path invent one would move the
  // prescription off the visit it belongs to.
  const createVisitIfMissing = isEditing ? false : shouldCreateNewVisit

  const [prescriptionItems, setPrescriptionItems] = useState<PrescriptionItem.T[]>([])
  const [isHydrating, setIsHydrating] = useState(isEditing)
  // Who wrote the prescription, which decides whether editing it also needs
  // canEditOtherProviderEvent. Blank until loaded, and blank is the strict case.
  const [prescriptionAuthorId, setPrescriptionAuthorId] = useState("")

  const { patient } = usePatientRecord(patientId)
  const patientRecord = Option.getOrNull(patient)

  const { clinics } = useDBClinicsList()

  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
    getValues,
    setValue,
    reset,
    watch,
  } = useForm<Prescription.T>({
    defaultValues: {
      ...Prescription.empty(),
      providerId,
      visitId: visitId || undefined,
      pickupClinicId: providerClinicId,
      patientId,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  })

  const [openPicker, setOpenPicker] = useState<
    "city" | "pickupClinic" | "priority" | "status" | null
  >(null)
  const [isSheetOpen, setIsSheetOpen] = useState(false)
  const isIos = Platform.OS === "ios"

  const [selectedCity, setSelectedCity] = useState("")

  // Clinics may have a null/blank city, so drop those before building the filter options.
  const cityOptions = useMemo(() => {
    const cities = clinics
      .map((clinic) => clinic.city?.trim())
      .filter((city): city is string => Boolean(city))
    return [...new Set(cities)].sort().map((city) => ({ label: city, value: city }))
  }, [clinics])

  const filteredClinics = useMemo(
    () => (selectedCity ? clinics.filter((clinic) => clinic.city === selectedCity) : clinics),
    [clinics, selectedCity],
  )

  const pickupClinicId = watch("pickupClinicId")

  // Stock differs between clinics, so items do not survive a change of pickup
  // clinic. Cleared where the clinic moves rather than in an effect on the
  // value — an effect also fires on hydration, wiping the items just loaded.
  const changePickupClinic = useCallback(
    (clinicId: string, onChange: (value: string) => void) => {
      if (clinicId === pickupClinicId) return
      onChange(clinicId)
      setPrescriptionItems([])
    },
    [pickupClinicId],
  )

  // If the chosen city no longer contains the selected pickup clinic, clear the stale selection.
  useEffect(() => {
    if (!selectedCity || !pickupClinicId) return
    if (!filteredClinics.some((clinic) => clinic.id === pickupClinicId)) {
      setValue("pickupClinicId", "")
      setPrescriptionItems([])
    }
  }, [selectedCity, pickupClinicId, filteredClinics, setValue])

  // Load the prescription being edited. Runs before anything can be submitted,
  // so a partially-loaded form is never what gets saved.
  useEffect(() => {
    if (!prescriptionId) return

    let cancelled = false

    const hydrate = async () => {
      try {
        const record = await database
          .get<Prescription.DB.T>(Prescription.DB.table_name)
          .find(prescriptionId)
        const items = await PrescriptionItem.DB.getByPrescriptionId(prescriptionId)
        if (cancelled) return

        reset(Prescription.DB.rawToT(record))
        setPrescriptionItems(items)
        setPrescriptionAuthorId(record.providerId || "")
      } catch (error) {
        if (cancelled) return
        Logger.error({ msg: "Failed to load the prescription being edited", error })
        Toast.show("Could not open this prescription for editing", {
          duration: Toast.durations.LONG,
          position: Toast.positions.BOTTOM,
        })
        navigation.goBack()
      } finally {
        if (!cancelled) setIsHydrating(false)
      }
    }

    hydrate()

    return () => {
      cancelled = true
    }
  }, [prescriptionId, reset, navigation])

  const [isLoading, setIsLoading] = useState(false)

  const bottomSheetModalRef = useRef<BottomSheetModal>(null)

  const snapPoints = useMemo(() => ["70%", "70%"], [])

  const handleSheetChanges = useCallback((index: number) => {
    Logger.log({ msg: "handleSheetChanges", index })
    if (index === -1) {
      setIsSheetOpen(false)
      return
    }
    setIsSheetOpen(true)
  }, [])

  // on press hardware back just close the modal. if modal is closed then go back
  const handleBackPress = useCallback(() => {
    if (isSheetOpen) {
      bottomSheetModalRef.current?.dismiss()
      return true
    }
    return false
  }, [isSheetOpen])

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", handleBackPress)
      return () => subscription.remove()
    }, [handleBackPress]),
  )

  /** No-op when the drug is already on the prescription. */
  const handleSelectItem = (item: ClinicInventory.DB.T) => {
    const drugId = item.drugId
    if (prescriptionItems.some((item) => item.drugId === drugId)) {
      bottomSheetModalRef.current?.dismiss()
      return
    }

    const prescriptionItemId = uuidV1()
    setPrescriptionItems((prevState) => [
      ...prevState,
      {
        ...PrescriptionItem.empty(prescriptionItemId),
        patientId: patientId,
        drugId,
        quantityPrescribed: 1,
        clinicId: pickupClinicId || providerClinicId || "",
      },
    ])

    bottomSheetModalRef.current?.dismiss()
  }

  const handleRemovePrescriptionItem = (itemId: string) => {
    setPrescriptionItems((prevState) => prevState.filter((item) => item.id !== itemId))
  }

  const handleUpdatePrescriptionItemQty = (itemId: string, quantityPrescribed: number) => {
    setPrescriptionItems((prevState) => {
      const updatedItems = prevState.map((item) => {
        if (item.id === itemId) {
          return { ...item, quantityPrescribed }
        }
        return item
      })
      return updatedItems
    })
  }

  const handleUpdatePrescriptionItemInstructions = (itemId: string, dosageInstructions: string) => {
    setPrescriptionItems((prevState) => {
      const updatedItems = prevState.map((item) => {
        if (item.id === itemId) {
          return { ...item, dosageInstructions }
        }
        return item
      })
      return updatedItems
    })
  }

  // Editing weighs who wrote the prescription; creating does not.
  const canSave = isEditing
    ? checkEditPrescription(prescriptionAuthorId).ok
    : can("prescription:create")

  const saveDeniedMessage = isEditing
    ? "You do not have permission to edit this prescription"
    : "You do not have permission to create prescriptions"

  const onSubmit = async (submission: Prescription.T) => {
    // The boundary, not the affordance: permissions load asynchronously and can
    // change under a screen that was left open.
    if (!canSave) {
      Toast.show(saveDeniedMessage, {
        duration: Toast.durations.SHORT,
        position: Toast.positions.BOTTOM,
      })
      return
    }

    // Stamped at save: a form default is captured at mount and backdates
    // anything saved later. An edit keeps the moment already on the record.
    const prescribedAt = isEditing ? submission.prescribedAt : new Date()

    const data: Prescription.T = {
      ...submission,
      prescribedAt,
      expirationDate: isEditing
        ? submission.expirationDate
        : Prescription.defaultExpirationDate(prescribedAt),
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const items = prescriptionItems.map((item) => ({
      ...item,
      patientId,
      clinicId: data.pickupClinicId || providerClinicId || "",
      recordedByUserId: providerId,
      recordedAt: new Date(),
    }))

    if (isLoading) {
      return
    }

    try {
      setIsLoading(true)
      const { prescriptionId: prescriptionIdResult, visitId: createdVisitId } =
        await Prescription.DB.create(
          prescriptionId || null,
          data,
          items,
          {
            clinicId: providerClinicId || "",
            id: providerId,
            name: providerName,
          },
          createVisitIfMissing,
        )

      if (!createdVisitId && !createVisitIfMissing) {
        navigation.goBack()
      } else if (createdVisitId) {
        navigation.goBack()
      } else {
        Toast.show("Error: visit was not created", {
          position: Toast.positions.BOTTOM,
          duration: Toast.durations.LONG,
        })
        navigation.goBack()
      }
    } catch (error) {
      Logger.error(error)
      Toast.show(isEditing ? "Error saving prescription" : "Error creating prescription", {
        position: Toast.positions.BOTTOM,
        duration: Toast.durations.LONG,
      })
    } finally {
      setIsLoading(false)
    }
  }

  if (isHydrating) {
    return (
      <Screen style={$root} preset="scroll">
        <Text text="Loading prescription..." />
      </Screen>
    )
  }

  if (!patientRecord) {
    return (
      <Screen style={$root} preset="scroll">
        <Text text="Loading patient..." />
      </Screen>
    )
  }

  return (
    <BottomSheetModalProvider>
      <Screen style={$root} preset="scroll">
        <View py={theme.spacing.md}>
          <Text testID="patient-name" size="xl" text={Patient.displayName(patientRecord)} />
          <Text testID="patient-age" text={`Age: ${calculateAge(patientRecord.dateOfBirth)}`} />
          <Text testID="patient-sex" text={`Sex: ${patientRecord.sex}`} />
        </View>

        <View gap={theme.spacing.md} pt={20}>
          <If condition={cityOptions.length > 0}>
            <View>
              <Text preset="formLabel" text="City" />
              <PlatformPicker
                isIos={isIos}
                options={cityOptions}
                fieldKey="city"
                label="All cities"
                modalTitle="City"
                setValue={() => (value: string) => setSelectedCity(value)}
                setOpen={(value: boolean) => setOpenPicker(value ? "city" : null)}
                isOpen={openPicker === "city"}
                value={selectedCity}
              />
            </View>
          </If>

          <Controller
            control={control}
            name="pickupClinicId"
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
                <PlatformPicker
                  isIos={isIos}
                  options={sortBy(filteredClinics, ["name"]).map((clinic) => ({
                    label: clinic.name,
                    value: clinic.id,
                  }))}
                  fieldKey="pickupClinicId"
                  modalTitle="Pickup Clinic"
                  setValue={() => (value: string) => changePickupClinic(value, field.onChange)}
                  setOpen={(value: boolean) => setOpenPicker(value ? "pickupClinic" : null)}
                  isOpen={openPicker === "pickupClinic"}
                  value={field.value || ""}
                />
              </View>
            )}
          />

          <Controller
            control={control}
            name="status"
            render={({ field }) => (
              <View gap={4}>
                <Text preset="formLabel" text="Status" />
                {Prescription.statusList.map((status) => (
                  <Radio
                    key={status}
                    label={friendlyString(status)}
                    value={field.value === status}
                    onValueChange={(value: boolean) => {
                      field.onChange(status)
                    }}
                  />
                ))}
              </View>
            )}
          />

          <Controller
            control={control}
            name="priority"
            render={({ field }) => (
              <View gap={4}>
                <Text preset="formLabel" text="Priority" />
                {Prescription.priorityList.map((priority) => (
                  <Radio
                    key={priority}
                    label={friendlyString(priority)}
                    value={field.value === priority}
                    onValueChange={(value: boolean) => {
                      field.onChange(priority)
                    }}
                  />
                ))}
              </View>
            )}
          />

          <Controller
            control={control}
            name="notes"
            render={({ field: { onChange, onBlur, value } }) => (
              <TextField
                multiline
                testID="prescription-notes"
                labelTx="appointmentEditorForm:notes"
                onChangeText={onChange}
                onBlur={onBlur}
                value={value}
              />
            )}
          />
        </View>

        <View gap={theme.spacing.lg} pt={20}>
          {prescriptionItems.map((item) => (
            <View key={item.id} gap={theme.spacing.sm} testID="prescription-item">
              <PrescriptionItemEditor
                drugId={item.drugId}
                quantity={item.quantityPrescribed}
                quantityDispensed={item.quantityDispensed}
                instructions={item.dosageInstructions}
                onQtyChange={(qty: number) => handleUpdatePrescriptionItemQty(item.id, qty)}
                onInstructionsChange={(instructions: string) =>
                  handleUpdatePrescriptionItemInstructions(item.id, instructions)
                }
                onRemove={() => handleRemovePrescriptionItem(item.id)}
              />
            </View>
          ))}
        </View>

        <View py={16} alignItems="center" mt={8}>
          <Pressable
            testID="open-add-prescription-item-form"
            onPress={() => bottomSheetModalRef.current?.present()}
          >
            <View direction="row" gap={8}>
              <LucidePlus color={theme.colors.palette.primary600} />
              <Text
                text="Add Prescription Item"
                color={theme.colors.palette.primary600}
                textDecorationLine="underline"
              />
            </View>
          </Pressable>
        </View>

        <If condition={prescriptionItems.length > 0}>
          <View py={16}>
            {isLoadingPermissions ? (
              <Text text="Checking permissions..." />
            ) : canSave ? (
              <Button
                preset="defaultPrimary"
                testID="submit-prescription"
                onPress={handleSubmit(onSubmit)}
              >
                Submit
              </Button>
            ) : (
              <Text testID="prescription-permission-denied" text={saveDeniedMessage} />
            )}
          </View>
        </If>

        <View height={100} />
      </Screen>

      <BottomSheetModal
        ref={bottomSheetModalRef}
        index={1}
        snapPoints={snapPoints}
        onChange={handleSheetChanges}
      >
        <BottomSheetScrollView style={{}}>
          <If condition={!pickupClinicId}>
            <View px={16}>
              <Text>Choose a clinic to pick up the prescription from</Text>
            </View>
          </If>
          <View px={16}>
            {pickupClinicId && (
              <ClinicInventorySearch clinicId={pickupClinicId} onSelectItem={handleSelectItem} />
            )}
          </View>
        </BottomSheetScrollView>
      </BottomSheetModal>
    </BottomSheetModalProvider>
  )
}

const enhancePrescriptionItemEditor = withObservables(
  ["drugId"],
  ({ drugId }: { drugId: string }) => {
    return {
      drug: database
        .get<DrugCatalogue.DB.T>("drug_catalogue")
        .findAndObserve(drugId)
        .pipe(catchError(() => of$(null))),
    }
  },
)

const PrescriptionItemEditor = enhancePrescriptionItemEditor(
  ({
    drug,
    quantity,
    quantityDispensed = 0,
    instructions,
    onRemove,
    onQtyChange,
    onInstructionsChange,
  }: {
    drug: DrugCatalogue.DB.T | null
    quantity: number
    /** Units already handed to the patient. Above zero locks the row. */
    quantityDispensed?: number
    instructions: string
    onRemove: () => void
    onQtyChange: (qty: number) => void
    onInstructionsChange: (instructions: string) => void
  }) => {
    const { themed, theme } = useAppTheme()
    // Dispensed medication has left the pharmacy and is recorded in
    // dispensing_records; changing the row would contradict that history.
    const isDispensed = quantityDispensed > 0

    if (!drug) {
      return (
        <View style={themed($prescriptionItemEditorContainer)}>
          <Text>Drug not found</Text>
        </View>
      )
    }

    return (
      <View style={themed($prescriptionItemEditorContainer)}>
        <View gap={8}>
          <View direction="row" justifyContent="space-between">
            <View direction="row" alignItems="baseline" gap={4}>
              <Text size="lg">{drug.brandName}</Text>
              <Text>({drug.genericName})</Text>
            </View>

            <If condition={!isDispensed}>
              <Pressable testID="remove-prescription-item" onPress={onRemove}>
                <LucideX size={24} color={theme.colors.palette.neutral900} />
              </Pressable>
            </If>
          </View>
          <Text>
            {friendlyString(drug.form)} {drug.dosageQuantity}
            {drug.dosageUnits} {drug.route}
          </Text>
          <If condition={isDispensed}>
            <Text
              testID="prescription-item-dispensed-note"
              size="xs"
              color={theme.colors.textDim}
              text={`${quantityDispensed} already dispensed — this item can no longer be changed`}
            />
          </If>
        </View>
        <View gap={8}>
          <TextField
            testID="prescription-item-quantity"
            label="Quantity"
            keyboardType="numeric"
            placeholder="How many units should be dispensed?"
            editable={!isDispensed}
            defaultValue={quantity.toString()}
            onChangeText={(t) => (!isNaN(Number(t)) ? onQtyChange(parseInt(t)) : null)}
          />
          <TextField
            testID="prescription-item-instructions"
            label="Dosage Instructions"
            keyboardType="default"
            multiline
            editable={!isDispensed}
            onChangeText={(t) => onInstructionsChange(t)}
            value={instructions}
            placeholder="Enter dosage instructions"
          />
        </View>
      </View>
    )
  },
)

const $prescriptionItemEditorContainer: ThemedStyle<ViewStyle> = ({ colors }) => ({
  padding: 16,
  borderRadius: 8,
  backgroundColor: colors.palette.neutral300,
})

function ClinicInventorySearch({
  onSelectItem,
  clinicId,
}: {
  onSelectItem: (item: ClinicInventory.DB.T) => void
  clinicId: string
}) {
  const { themed } = useAppTheme()
  const [searchQuery, setSearchQuery] = useDebounceValue("", 1000)

  const { isLoading, data: inventoryItems } = useDBClinicInventorySearch(searchQuery, clinicId)

  const inventoryItemBatches = Object.entries(groupBy(inventoryItems, (item) => item.drugId))

  return (
    <View>
      <TextField
        testID="clinic-inventory-search"
        label="Search Medication"
        placeholder="Enter medicine name"
        onChangeText={(text) => setSearchQuery(text)}
      />

      <View gap={8} mt={10}>
        {inventoryItemBatches.map(([drugId, items]) => (
          <Pressable
            testID={`inventory-item-${drugId}`}
            key={drugId}
            onPress={() => onSelectItem(items[0])}
          >
            <View style={themed($inventoryItemBtn)}>
              <InventoryItem inventoryItem={items[0]} />
              <Text>{items.reduce((acc, item) => acc + item.quantityAvailable, 0)} remaining</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const enhanceInventoryItem = withObservables(
  ["inventoryItem"],
  ({ inventoryItem }: { inventoryItem: ClinicInventory.DB.T }) => ({
    inventoryItem,
    // withObservables re-throws a relation error during render, taking down the
    // whole editor rather than this row. Test the foreign key, then catch a
    // dangling id.
    drug: inventoryItem.drugId
      ? inventoryItem.drug.observe().pipe(catchError(() => of$(null)))
      : of$(null),
  }),
)

export const InventoryItem = enhanceInventoryItem(
  ({ drug }: { inventoryItem: ClinicInventory.DB.T; drug: DrugCatalogue.DB.T | null }) => {
    const { theme } = useAppTheme()

    // The parent renders this inside a Pressable, so a blank row would still be
    // selectable — say why it is empty rather than leaving it silent.
    if (!drug) {
      return <Text size="lg" text="Drug details unavailable" />
    }

    return (
      <View>
        <Text size="lg" testID={`drug-brand-name-${drug.id}`}>
          {drug.brandName} - {drug.dosageQuantity} {drug.dosageUnits}{" "}
        </Text>
        <Text color={theme.colors.textDim} testID={`drug-generic-name-${drug.id}`}>
          {drug.genericName}
        </Text>
        <Text testID={`drug-form-route-${drug.id}`}>
          {upperFirst(drug.form)} {drug.route}
        </Text>
      </View>
    )
  },
)

function useDBClinicInventorySearch(searchTerm: string, clinicId: string) {
  const [data, setData] = useState<ClinicInventory.DB.T[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    setIsLoading(true)
    const queryTerm = Q.like(`%${sanitizeLikeString(searchTerm)}%`)
    const sub = database
      .get<ClinicInventory.DB.T>("clinic_inventory")
      .query(
        Q.where("clinic_id", clinicId),
        Q.on("drug_catalogue", [
          Q.or(
            Q.where("generic_name", queryTerm),
            Q.where("brand_name", queryTerm),
            Q.where("barcode", queryTerm),
          ),
        ]),
        Q.where("quantity_available", Q.gt(0)),
        Q.take(15),
      )
      .observe()
      .subscribe((items) => {
        setData(items)
        setIsLoading(false)
      })

    return () => {
      sub.unsubscribe()
    }
  }, [searchTerm, clinicId])

  return { isLoading, data }
}

const $root: ViewStyle = {
  flex: 1,
  paddingHorizontal: 14,
}

const $inventoryItemBtn: ThemedStyle<ViewStyle> = ({ colors }) => ({
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
  backgroundColor: colors.palette.neutral200,
  borderRadius: 8,
})
