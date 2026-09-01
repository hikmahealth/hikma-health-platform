/**
 * The edit affordance on the patient prescriptions list.
 *
 * The permission rules themselves are covered in
 * `test/models/UserClinicPermissions.test.ts`; what this file pins is that the
 * list asks about the prescription's own author, hides the button while the
 * answer is still loading, and hands the editor the parameters that make it
 * open in edit mode rather than create mode.
 */

import React from "react"
import { fireEvent } from "@testing-library/react-native"

import { render } from "../helpers/renderWithProviders"

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

jest.mock("@react-navigation/native", () => ({
  useFocusEffect: jest.fn((cb) => cb()),
  useScrollToTop: jest.fn(),
}))

// Pass the observed props straight through; the card tolerates null items/drugs.
jest.mock("@nozbe/watermelondb/react", () => ({
  withObservables: () => (component: any) => component,
}))

jest.mock("@/db", () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => ({
      query: jest.fn(() => ({
        observe: jest.fn(() => ({
          subscribe: jest.fn((onNext: any) => {
            onNext((global as any).__RX_LIST__)
            return { unsubscribe: jest.fn() }
          }),
        })),
      })),
    })),
  },
}))

jest.mock("@/hooks/usePatientRecord", () => ({
  usePatientRecord: jest.fn(() => ({
    patient: { id: "patient-1", givenName: "Jane", surname: "Doe" },
    isLoading: false,
  })),
}))

jest.mock("@/hooks/usePermissionGuard", () => ({
  usePermissionGuard: jest.fn(() => (global as any).__PERM_GUARD__),
}))

jest.mock("lucide-react-native", () => ({
  PlusIcon: () => "PlusIcon",
  PillIcon: () => "PillIcon",
  ClockIcon: () => "ClockIcon",
  CalendarIcon: () => "CalendarIcon",
  AlertCircleIcon: () => "AlertCircleIcon",
  CheckCircleIcon: () => "CheckCircleIcon",
  XCircleIcon: () => "XCircleIcon",
  PackageIcon: () => "PackageIcon",
  PencilIcon: () => "PencilIcon",
  LucideFileCheck: () => "LucideFileCheck",
}))

import { PatientPrescriptionsListScreen } from "../../app/screens/PatientPrescriptionsListScreen"

const mockNavigation: any = {
  navigate: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
}

const mockRoute: any = {
  key: "PatientPrescriptionsList-test",
  name: "PatientPrescriptionsList",
  params: { patientId: "patient-1" },
}

const prescription = (over: Record<string, unknown> = {}) => ({
  id: "rx-000001",
  patientId: "patient-1",
  providerId: "provider-1",
  visitId: "visit-1",
  status: "pending",
  priority: "normal",
  notes: "",
  prescribedAt: new Date("2024-01-01"),
  expirationDate: new Date("2030-01-01"),
  filledAt: null,
  ...over,
})

const guard = (over: Record<string, unknown> = {}) => ({
  permissions: null,
  isLoading: false,
  can: jest.fn(() => true),
  check: jest.fn(),
  checkOperation: jest.fn(),
  checkEditEvent: jest.fn(),
  checkEditPrescription: jest.fn(() => ({ ok: true })),
  ...over,
})

beforeEach(() => {
  mockNavigation.navigate.mockClear()
  ;(global as any).__RX_LIST__ = [prescription()]
  ;(global as any).__PERM_GUARD__ = guard()
})

const renderScreen = () =>
  render(<PatientPrescriptionsListScreen navigation={mockNavigation} route={mockRoute} />)

describe("PatientPrescriptionsListScreen — edit entry point", () => {
  it("offers edit on a prescription the user may edit", () => {
    const { getByTestId } = renderScreen()
    expect(getByTestId("edit-prescription-rx-000001")).toBeTruthy()
  })

  it("hides edit when the user may not edit that prescription", () => {
    ;(global as any).__PERM_GUARD__ = guard({
      checkEditPrescription: jest.fn(() => ({ ok: false })),
    })

    const { queryByTestId } = renderScreen()
    expect(queryByTestId("edit-prescription-rx-000001")).toBeNull()
  })

  it("hides edit while the permission answer is still loading", () => {
    ;(global as any).__PERM_GUARD__ = guard({ isLoading: true })

    const { queryByTestId } = renderScreen()
    expect(queryByTestId("edit-prescription-rx-000001")).toBeNull()
  })

  it("asks about the prescription's own author, not the signed-in user", () => {
    const permissions = guard()
    ;(global as any).__PERM_GUARD__ = permissions
    ;(global as any).__RX_LIST__ = [prescription({ providerId: "someone-else" })]

    renderScreen()
    expect(permissions.checkEditPrescription).toHaveBeenCalledWith("someone-else")
  })

  it("opens the editor in edit mode rather than create mode", () => {
    const { getByTestId } = renderScreen()

    fireEvent.press(getByTestId("edit-prescription-rx-000001"))

    expect(mockNavigation.navigate).toHaveBeenCalledWith("PrescriptionEditorForm", {
      patientId: "patient-1",
      prescriptionId: "rx-000001",
      visitId: "visit-1",
      shouldCreateNewVisit: false,
    })
  })

  it("still creates a fresh prescription from the action button", () => {
    const { getByTestId } = renderScreen()

    fireEvent.press(getByTestId("new-patient-prescription"))

    expect(mockNavigation.navigate).toHaveBeenCalledWith("PrescriptionEditorForm", {
      patientId: "patient-1",
      prescriptionId: undefined,
      visitId: undefined,
      shouldCreateNewVisit: false,
    })
  })

  it("renders one edit control per editable prescription", () => {
    ;(global as any).__RX_LIST__ = [prescription({ id: "rx-a" }), prescription({ id: "rx-b" })]

    const { getByTestId } = renderScreen()
    expect(getByTestId("edit-prescription-rx-a")).toBeTruthy()
    expect(getByTestId("edit-prescription-rx-b")).toBeTruthy()
  })
})
