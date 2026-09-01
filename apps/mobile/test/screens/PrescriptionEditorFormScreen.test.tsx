import React from "react"
import { fireEvent, waitFor } from "@testing-library/react-native"
import { differenceInCalendarDays } from "date-fns"
import { render } from "../helpers/renderWithProviders"
import { PrescriptionEditorFormScreen } from "../../app/screens/PrescriptionEditorFormScreen"
import Prescription from "@/models/Prescription"

jest.mock("react-native-keyboard-controller", () => {
  const RN = require("react-native")
  return {
    KeyboardAwareScrollView: RN.ScrollView,
    KeyboardProvider: ({ children }: any) => children,
  }
})

jest.mock("react-native-edge-to-edge", () => ({
  SystemBars: () => null,
}))

jest.mock("expo-screen-orientation", () => ({
  addOrientationChangeListener: jest.fn(() => ({ remove: jest.fn() })),
  removeOrientationChangeListener: jest.fn(),
  getOrientationAsync: jest.fn(() => Promise.resolve(1)),
  OrientationLock: { DEFAULT: 0 },
  Orientation: { PORTRAIT_UP: 1 },
}))

jest.mock("@xstate/react", () => ({
  useSelector: jest.fn((_store: any, selector: (state: any) => any) => {
    const { Option } = require("effect")
    return selector({
      context: {
        id: "provider-1",
        name: "Dr. Test",
        email: "test@test.com",
        role: Option.some("provider"),
        instance_url: Option.some("https://example.com"),
        clinic_id: Option.some("clinic-1"),
        clinic_name: Option.some("Test Clinic"),
        permissions: Option.none(),
      },
    })
  }),
}))

jest.mock("@/store/provider", () => ({
  providerStore: {},
}))

jest.mock("@react-navigation/native", () => ({
  useFocusEffect: jest.fn((cb) => cb()),
  useScrollToTop: jest.fn(),
}))

// Bottom sheet — inline mock based on upstream mock.js (local copy has JSX that Jest can't parse)
jest.mock("@gorhom/bottom-sheet", () => {
  const React = require("react")
  const RN = require("react-native")
  const NOOP = () => {}
  const NOOP_VALUE = { value: 0, set: NOOP, get: () => 0 }

  class MockBottomSheetModal extends React.Component {
    state = { visible: false }
    data = null
    snapToIndex() {}
    snapToPosition() {}
    expand() {}
    collapse() {}
    close() { this.data = null; this.setState({ visible: false }) }
    forceClose() { this.data = null; this.setState({ visible: false }) }
    present(data: any) { this.data = data; this.setState({ visible: true }) }
    dismiss() { this.data = null; this.setState({ visible: false }) }
    render() {
      if (!this.state.visible) return null
      const { children: Content } = this.props
      return typeof Content === "function"
        ? React.createElement(Content, { data: this.data })
        : Content
    }
  }

  class MockBottomSheet extends React.Component {
    snapToIndex() {}
    snapToPosition() {}
    expand() {}
    collapse() {}
    close() {}
    forceClose() {}
    render() { return this.props.children }
  }

  return {
    __esModule: true,
    default: MockBottomSheet,
    BottomSheetModal: MockBottomSheetModal,
    BottomSheetModalProvider: ({ children }: any) => children,
    BottomSheetView: (props: any) => props.children,
    BottomSheetScrollView: RN.ScrollView,
    BottomSheetSectionList: RN.SectionList,
    BottomSheetFlatList: RN.FlatList,
    BottomSheetTextInput: RN.TextInput,
    BottomSheetBackdrop: NOOP,
    useBottomSheet: () => ({
      snapToIndex: NOOP, snapToPosition: NOOP, expand: NOOP,
      collapse: NOOP, close: NOOP, forceClose: NOOP,
      animatedIndex: NOOP_VALUE, animatedPosition: NOOP_VALUE,
    }),
    useBottomSheetModal: () => ({ dismiss: NOOP, dismissAll: NOOP }),
  }
})

// WatermelonDB withObservables — render the inner component with the props as-is.
// The observed `drug` is supplied from a global so item rows render their real
// body instead of the "Drug not found" fallback; explicit props still win.
jest.mock("@nozbe/watermelondb/react", () => ({
  withObservables: () => (component: any) => (props: any) =>
    require("react").createElement(component, { drug: (global as any).__DRUG__, ...props }),
}))

jest.mock("@/db", () => ({
  __esModule: true,
  default: {
    // Only the clinic inventory emits, and only what a test put in
    // `__INVENTORY__`. Every other collection keeps the silent subscription
    // the rest of this file was written against.
    get: jest.fn((table: string) => ({
      find: jest.fn(() => (global as any).__RX_FIND__()),
      findAndObserve: jest.fn(),
      query: jest.fn(() => ({
        observe: jest.fn(() => ({
          subscribe: jest.fn((next?: (rows: unknown[]) => void) => {
            if (table === "clinic_inventory" && next) {
              next((global as any).__INVENTORY__ ?? [])
            }
            return { unsubscribe: jest.fn() }
          }),
          pipe: jest.fn(() => ({
            subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
          })),
        })),
      })),
    })),
  },
}))

jest.mock("@/hooks/usePatientRecord", () => ({
  usePatientRecord: jest.fn(() => {
    const { Option } = require("effect")
    return {
      patient: {
        id: "patient-1",
        givenName: "Jane",
        surname: "Doe",
        dateOfBirth: "1990-01-01",
        sex: "female",
        citizenship: "",
        hometown: "",
        phone: "",
        camp: "",
        photoUrl: "",
        governmentId: "",
        externalPatientId: "",
        additionalData: {},
        metadata: {},
        isDeleted: false,
        deletedAt: Option.none(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      isLoading: false,
    }
  }),
}))

jest.mock("@/hooks/useDBClinicsList", () => ({
  useDBClinicsList: jest.fn(() => ({
    clinics: [
      { id: "clinic-1", name: "Test Clinic" },
      { id: "clinic-2", name: "Other Clinic" },
    ],
    isLoading: false,
  })),
}))

jest.mock("@/hooks/usePermissionGuard", () => ({
  usePermissionGuard: jest.fn(() => (global as any).__PERM_GUARD__),
}))

jest.mock("@/models/PrescriptionItem", () => {
  const actual = jest.requireActual("@/models/PrescriptionItem")
  return {
    __esModule: true,
    default: {
      ...actual.default,
      DB: {
        ...actual.default.DB,
        getByPrescriptionId: jest.fn(() => Promise.resolve((global as any).__RX_ITEMS__)),
      },
    },
  }
})

jest.mock("react-native-root-toast", () => ({
  show: jest.fn(),
  durations: { SHORT: 2000 },
  positions: { BOTTOM: -40 },
}))

jest.mock("lucide-react-native", () => ({
  LucidePlus: () => "LucidePlus",
  LucideX: () => "LucideX",
}))

jest.mock("usehooks-ts", () => ({
  useDebounceValue: jest.fn((val: string) => [val, jest.fn()]),
}))

const mockNavigation: any = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
  popTo: jest.fn(),
}

const mockRoute: any = {
  key: "PrescriptionEditorForm-test",
  name: "PrescriptionEditorForm",
  params: {
    patientId: "patient-1",
    visitId: "visit-1",
    prescriptionId: undefined,
    shouldCreateNewVisit: false,
  },
}

const editRoute = (params: Record<string, unknown> = {}): any => ({
  ...mockRoute,
  params: { ...mockRoute.params, prescriptionId: "rx-1", ...params },
})

const existingPrescription = {
  id: "rx-1",
  patientId: "patient-1",
  providerId: "provider-1",
  filledBy: null,
  // Deliberately not the provider's own clinic: hydration must survive the
  // pickup clinic actually changing, which is what clears the item list.
  pickupClinicId: "clinic-2",
  visitId: "visit-1",
  priority: "normal",
  status: "pending",
  items: [],
  notes: "take with food",
  expirationDate: new Date("2030-01-01"),
  prescribedAt: new Date("2024-01-01"),
  filledAt: null,
  metadata: {},
  isDeleted: false,
  deletedAt: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
}

const existingItem = (over: Record<string, unknown> = {}) => ({
  id: "item-1",
  prescriptionId: "rx-1",
  patientId: "patient-1",
  drugId: "drug-1",
  clinicId: "clinic-1",
  dosageInstructions: "one at night",
  quantityPrescribed: 10,
  quantityDispensed: 0,
  refillsAuthorized: 0,
  refillsUsed: 0,
  itemStatus: "active",
  notes: null,
  isDeleted: false,
  recordedByUserId: "provider-1",
  metadata: {},
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  deletedAt: null,
  ...over,
})

const allowAll = () => ({
  permissions: null,
  isLoading: false,
  can: jest.fn(() => true),
  check: jest.fn(),
  checkOperation: jest.fn(),
  checkEditEvent: jest.fn(),
  checkEditPrescription: jest.fn(() => ({ ok: true })),
})

beforeEach(() => {
  ;(global as any).__DRUG__ = {
    id: "drug-1",
    brandName: "Panadol",
    genericName: "paracetamol",
    form: "tablet",
    dosageQuantity: 500,
    dosageUnits: "mg",
    route: "oral",
  }
  ;(global as any).__PERM_GUARD__ = allowAll()
  ;(global as any).__RX_FIND__ = () => Promise.resolve(existingPrescription)
  ;(global as any).__RX_ITEMS__ = []
  ;(global as any).__INVENTORY__ = []
})

const stockedDrug = { id: "inventory-1", drugId: "drug-1", quantityAvailable: 20 }

describe("PrescriptionEditorFormScreen", () => {
  it("renders without crashing", () => {
    const { toJSON, getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={mockRoute} />,
    )

    expect(toJSON()).toBeTruthy()
    expect(getByTestId("patient-name")).toBeTruthy()
    expect(getByTestId("patient-age")).toBeTruthy()
    expect(getByTestId("patient-sex")).toBeTruthy()
  })

  it("shows bottom sheet content when pressing add prescription item", async () => {
    const { getByTestId, queryByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={mockRoute} />,
    )

    // Bottom sheet content should not be visible initially
    expect(queryByTestId("clinic-inventory-search")).toBeNull()

    fireEvent.press(getByTestId("open-add-prescription-item-form"))

    // After pressing, the bottom sheet should render its content
    await waitFor(() => {
      expect(getByTestId("clinic-inventory-search")).toBeTruthy()
    })
  })
})

describe("PrescriptionEditorFormScreen — editing", () => {
  it("loads the existing prescription into the form", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem()]

    const { getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getByTestId("prescription-notes").props.value).toBe("take with food")
    })
  })

  it("keeps the loaded items instead of clearing them on hydration", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem()]

    const { getAllByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getAllByTestId("prescription-item")).toHaveLength(1)
    })
  })

  it("offers Submit when the user may edit this prescription", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem()]

    const { getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getByTestId("submit-prescription")).toBeTruthy()
    })
  })

  it("replaces Submit with a reason when the user may not edit it", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem()]
    ;(global as any).__PERM_GUARD__ = {
      ...allowAll(),
      // Creating is allowed; editing this one is not. Only the edit check counts.
      can: jest.fn(() => true),
      checkEditPrescription: jest.fn(() => ({ ok: false })),
    }

    const { getByTestId, queryByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getByTestId("prescription-permission-denied")).toBeTruthy()
    })
    expect(queryByTestId("submit-prescription")).toBeNull()
  })

  it("asks the edit check about the prescription's own author", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem()]
    const guard = allowAll()
    ;(global as any).__PERM_GUARD__ = guard

    render(<PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />)

    await waitFor(() => {
      expect(guard.checkEditPrescription).toHaveBeenCalledWith("provider-1")
    })
  })

  it("does not offer to remove an item that has been dispensed", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem({ quantityDispensed: 4 })]

    const { getByTestId, queryByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getByTestId("prescription-item-dispensed-note")).toBeTruthy()
    })
    expect(queryByTestId("remove-prescription-item")).toBeNull()
    expect(getByTestId("prescription-item-quantity").props.editable).toBe(false)
  })

  it("leaves an undispensed item removable", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem({ quantityDispensed: 0 })]

    const { getByTestId, queryByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getByTestId("remove-prescription-item")).toBeTruthy()
    })
    expect(queryByTestId("prescription-item-dispensed-note")).toBeNull()
  })

  it("shows the prescribed quantity, not the dispensed one", async () => {
    ;(global as any).__RX_ITEMS__ = [
      existingItem({ quantityPrescribed: 10, quantityDispensed: 4 }),
    ]

    const { getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => {
      expect(getByTestId("prescription-item-quantity").props.defaultValue).toBe("10")
    })
  })

  it("goes back when the prescription cannot be loaded", async () => {
    ;(global as any).__RX_FIND__ = () => Promise.reject(new Error("not found"))

    render(<PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />)

    await waitFor(() => {
      expect(mockNavigation.goBack).toHaveBeenCalled()
    })
  })
})

/**
 * `prescribed_at` is what the pharmacy day view buckets on, so a stale one
 * files a prescription under the wrong day. It has no control on this form —
 * the only place it can be set correctly is at save.
 */
describe("PrescriptionEditorFormScreen — prescribing time", () => {
  const OPENED_AT = new Date(2019, 2, 14, 23, 40)
  const SAVED_AT = new Date(2019, 2, 15, 9, 15)

  let create: jest.SpyInstance

  beforeEach(() => {
    create = jest
      .spyOn(Prescription.DB, "create")
      .mockResolvedValue({ prescriptionId: "rx-new", visitId: "visit-1" })
  })

  afterEach(() => {
    create.mockRestore()
    jest.useRealTimers()
  })

  const savedPrescription = () => create.mock.calls[0][1] as Prescription.T

  it("stamps a new prescription with the day it was saved, not the day it was opened", async () => {
    ;(global as any).__INVENTORY__ = [stockedDrug]

    jest.useFakeTimers()
    jest.setSystemTime(OPENED_AT)

    const { getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={mockRoute} />,
    )

    fireEvent.press(getByTestId("open-add-prescription-item-form"))
    await waitFor(() => expect(getByTestId("clinic-inventory-search")).toBeTruthy())
    fireEvent.press(getByTestId("inventory-item-drug-1"))
    await waitFor(() => expect(getByTestId("submit-prescription")).toBeTruthy())

    // The form has now been open across midnight, which is where a default
    // captured at mount — or at import — files the prescription a day early.
    jest.setSystemTime(SAVED_AT)
    fireEvent.press(getByTestId("submit-prescription"))

    await waitFor(() => expect(create).toHaveBeenCalled())
    const { prescribedAt } = savedPrescription()
    expect(differenceInCalendarDays(prescribedAt, SAVED_AT)).toBe(0)
    expect(prescribedAt.getTime()).toBeGreaterThanOrEqual(SAVED_AT.getTime())
  })

  it("gives a new prescription a future expiry", async () => {
    ;(global as any).__INVENTORY__ = [stockedDrug]

    const { getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={mockRoute} />,
    )

    fireEvent.press(getByTestId("open-add-prescription-item-form"))
    await waitFor(() => expect(getByTestId("clinic-inventory-search")).toBeTruthy())
    fireEvent.press(getByTestId("inventory-item-drug-1"))

    await waitFor(() => expect(getByTestId("submit-prescription")).toBeTruthy())
    fireEvent.press(getByTestId("submit-prescription"))

    await waitFor(() => expect(create).toHaveBeenCalled())
    const saved = savedPrescription()
    expect(saved.expirationDate).toEqual(Prescription.defaultExpirationDate(saved.prescribedAt))
    expect(saved.expirationDate.getTime()).toBeGreaterThan(saved.prescribedAt.getTime())
  })

  it("keeps the original prescribing moment when an existing one is edited", async () => {
    ;(global as any).__RX_ITEMS__ = [existingItem()]

    const { getByTestId } = render(
      <PrescriptionEditorFormScreen navigation={mockNavigation} route={editRoute()} />,
    )

    await waitFor(() => expect(getByTestId("submit-prescription")).toBeTruthy())
    fireEvent.press(getByTestId("submit-prescription"))

    await waitFor(() => expect(create).toHaveBeenCalled())
    const saved = savedPrescription()
    expect(saved.prescribedAt).toEqual(existingPrescription.prescribedAt)
    expect(saved.expirationDate).toEqual(existingPrescription.expirationDate)
  })
})
