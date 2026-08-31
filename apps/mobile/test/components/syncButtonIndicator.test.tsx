/**
 * The header/drawer sync button. A press is never silent.
 *
 * The bug this pins: the button started a sync only when `syncStore` read IDLE,
 * so a run that ended without reporting turned it into a no-op — no toast, no
 * log, no animation — for the rest of the session.
 */

import { render, fireEvent, waitFor, act } from "@testing-library/react-native"

const mockStartSync = jest.fn()
const mockIsSyncActive = jest.fn()

// Mocked whole: the real module reaches `@/db`, which never lets a single-file jest run exit.
jest.mock("@/services/syncService", () => ({
  startSync: (...args: unknown[]) => mockStartSync(...args),
  isSyncActive: () => mockIsSyncActive(),
  isSyncAvailable: jest.fn(async () => true),
}))

jest.mock("@/db", () => ({ __esModule: true, default: {}, databaseReady: Promise.resolve() }))

// Hand-rolled rather than `react-native-reanimated/mock`: `withRepeat` is where
// the spin is observable.
const mockWithRepeat = jest.fn((animation: unknown) => animation)
jest.mock("react-native-reanimated", () => {
  const RN = require("react-native")
  return {
    __esModule: true,
    default: { View: RN.View },
    useSharedValue: (initial: number) => ({ value: initial }),
    useAnimatedStyle: () => ({}),
    withRepeat: (...args: unknown[]) => mockWithRepeat(...args),
    withTiming: (toValue: number) => toValue,
    cancelAnimation: jest.fn(),
  }
})

const mockToastShow = jest.fn()
jest.mock("react-native-root-toast", () => ({
  __esModule: true,
  default: {
    show: (...args: unknown[]) => mockToastShow(...args),
    positions: { BOTTOM: 0 },
    durations: { LONG: 0 },
  },
}))

jest.mock("@sentry/react-native", () => ({ addBreadcrumb: jest.fn() }))
jest.mock("@/i18n/translate", () => ({ translate: (key: string) => key }))

import Sync from "@/models/Sync"
import { SyncButtonIndicator } from "@/components/SyncButtonIndicator"
import { syncStore } from "@/store/sync"

const press = () => {
  const view = render(<SyncButtonIndicator />)
  fireEvent.press(view.getByTestId("syncButton"))
  return view
}

/** Let the promise `startSync` returned settle, and the render it drives. */
const settle = () => act(async () => {})

/** Put the store in a state no run is going to move it out of. */
const wedgeStoreAt = (state: Sync.StateT) => {
  syncStore.trigger.force_reset()
  if (state !== Sync.State.IDLE) syncStore.trigger.start_sync()
  if (state === Sync.State.ERROR) syncStore.trigger.error_sync({ error: "boom" })
}

beforeEach(() => {
  jest.clearAllMocks()
  syncStore.trigger.force_reset()
  mockStartSync.mockResolvedValue(undefined)
  mockIsSyncActive.mockReturnValue(false)
})

describe("SyncButtonIndicator", () => {
  it("starts a sync when nothing is running", async () => {
    press()
    await waitFor(() => expect(mockStartSync).toHaveBeenCalledTimes(1))
    await settle()
    expect(mockToastShow).not.toHaveBeenCalled()
  })

  // The service signs in and resolves a peer before it reports FETCHING.
  it("spins from the press, before the store reports any progress", async () => {
    let release = () => {}
    mockStartSync.mockImplementation(() => new Promise<void>((r) => (release = () => r())))

    press()

    expect(syncStore.getSnapshot().context.state).toBe(Sync.State.IDLE)
    expect(mockWithRepeat).toHaveBeenCalled()
    release()
    await settle()
  })

  // The reported bug: the store says a sync is happening, the service says nothing is.
  it("starts a sync when the store is stuck non-idle but nothing is running", async () => {
    wedgeStoreAt(Sync.State.FETCHING)

    press()

    await waitFor(() => expect(mockStartSync).toHaveBeenCalledTimes(1))
    await settle()
    expect(syncStore.getSnapshot().context.state).toBe(Sync.State.IDLE)
  })

  // The press used to be spent on `forceReset()` alone — the guard after it read
  // `isIdle` from the same render, still false.
  it("starts a sync on the first press after an error, not the second", async () => {
    wedgeStoreAt(Sync.State.ERROR)

    press()

    await waitFor(() => expect(mockStartSync).toHaveBeenCalledTimes(1))
    await settle()
  })

  it("tells the user instead of queueing when a sync is already running", async () => {
    mockIsSyncActive.mockReturnValue(true)

    press()

    expect(mockToastShow).toHaveBeenCalledWith("common:syncAlreadyRunning", expect.anything())
    expect(mockStartSync).not.toHaveBeenCalled()
  })

  // The service does not know about a run until it claims the lock, so the
  // component has to answer this press itself.
  it("tells the user on a second press while its own sync is still running", async () => {
    let release = () => {}
    mockStartSync.mockImplementation(() => new Promise<void>((r) => (release = () => r())))

    const view = press()
    fireEvent.press(view.getByTestId("syncButton"))

    expect(mockStartSync).toHaveBeenCalledTimes(1)
    expect(mockToastShow).toHaveBeenCalledWith("common:syncAlreadyRunning", expect.anything())
    release()
    await settle()
  })

  it("recovers from a failed sync so the next press still works", async () => {
    mockStartSync.mockRejectedValueOnce(new Error("no peer"))

    const view = press()
    await waitFor(() => expect(mockStartSync).toHaveBeenCalledTimes(1))

    mockStartSync.mockResolvedValue(undefined)
    fireEvent.press(view.getByTestId("syncButton"))
    await waitFor(() => expect(mockStartSync).toHaveBeenCalledTimes(2))
    await settle()
  })
})
