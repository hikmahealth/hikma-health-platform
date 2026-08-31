/**
 * The response ceiling on the cloud sync requests.
 *
 * The bug: an unanswered socket held the sync lock for the life of the process,
 * and only force-quitting recovered it. The ceiling bounds the wait for a
 * response, never the download — aborting a long pull is the one regression it
 * must not cause, so that is pinned here too.
 */

const CEILING_MS = 5 * 60_000

let capturedInit: RequestInit[] = []
let fetchImpl: (url: string, init: RequestInit) => Promise<unknown>

jest.mock("@/db", () => ({ __esModule: true, default: {}, databaseReady: Promise.resolve() }))

jest.mock("@/models/Peer", () => ({
  __esModule: true,
  default: {
    DB: {
      getById: jest.fn(async () => ({
        id: "peer-1",
        peerId: "peer-1",
        peerType: "cloud_server",
        metadata: { url: "https://example.test" },
      })),
      updateLastSyncedAt: jest.fn(async () => undefined),
    },
    getUrl: () => "https://example.test",
  },
}))

jest.mock("@/models/User", () => ({
  __esModule: true,
  default: { signIn: jest.fn(async () => undefined) },
}))

jest.mock("expo-secure-store", () => ({
  getItem: jest.fn(async () => "provider@example.test"),
}))

jest.mock("@sentry/react-native", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}))

// Only the pull matters here — the push takes the same code path and needs a
// full local-changes fixture.
jest.mock("@nozbe/watermelondb/sync", () => ({
  synchronize: async (options: {
    pullChanges: (a: { lastPulledAt: number; schemaVersion: number; migration: null }) => unknown
  }) => {
    await options.pullChanges({ lastPulledAt: 0, schemaVersion: 1, migration: null })
  },
}))

jest.mock("@/db/localSync", () => ({
  applyRemoteChanges: jest.fn(async () => undefined),
  fetchLocalChanges: jest.fn(async () => ({})),
  markLocalChangesAsSynced: jest.fn(async () => undefined),
}))

import { syncDB } from "@/db/peerSync"

const callbacks = () => ({
  hasLocalChangesToPush: false,
  setSyncStart: jest.fn(),
  setSyncResolution: jest.fn(),
  setPushStart: jest.fn(),
  updateSyncStatistic: jest.fn(),
  onSyncError: jest.fn(),
  onSyncCompleted: jest.fn(),
})

/** A response whose body arrives only when `deliver` is called. */
const bodyOnDemand = () => {
  let deliver = () => {}
  const json = () =>
    new Promise((resolve) => {
      deliver = () => resolve({ changes: {}, timestamp: 1 })
    })
  return { response: { ok: true, json }, deliver: () => deliver() }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  capturedInit = []
  global.fetch = ((url: string, init: RequestInit) => {
    capturedInit.push(init)
    return fetchImpl(url, init)
  }) as unknown as typeof fetch
})

afterEach(() => {
  jest.useRealTimers()
})

describe("cloud sync request ceiling", () => {
  it("abandons a request the server never answers", async () => {
    // Mirrors expo/fetch, which rejects the pending request on abort.
    fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")))
      })

    const cb = callbacks()
    const sync = syncDB("peer-1", cb)
    const settled = expect(sync).rejects.toThrow(/aborted/)

    await jest.advanceTimersByTimeAsync(CEILING_MS)

    await settled
    expect(cb.onSyncError).toHaveBeenCalled()
  })

  // A pull that answers promptly then takes twice the ceiling to transfer.
  it("does not abort a response that is slow to download", async () => {
    const { response, deliver } = bodyOnDemand()
    fetchImpl = async () => response

    const cb = callbacks()
    const sync = syncDB("peer-1", cb)

    await jest.advanceTimersByTimeAsync(CEILING_MS * 2)
    deliver()

    await expect(sync).resolves.toBeUndefined()
    expect(capturedInit[0].signal?.aborted).toBe(false)
  })

  it("puts a signal on the request", async () => {
    const { response, deliver } = bodyOnDemand()
    fetchImpl = async () => response

    const sync = syncDB("peer-1", callbacks())
    await jest.advanceTimersByTimeAsync(0)
    deliver()
    await sync

    expect(capturedInit[0].signal).toBeInstanceOf(AbortSignal)
  })
})
