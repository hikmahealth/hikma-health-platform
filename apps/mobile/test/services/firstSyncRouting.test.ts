/**
 * Which sync path a device takes on its very first run.
 *
 * A device that has never synced pulls the whole dataset. Through
 * `synchronize()` that is one unbounded JSON body and an OOM on any
 * established deployment; through `runManualSync` it is paged and resumable.
 *
 * The decision has to happen in `startSync` and not in `runSync`, because
 * `withSyncLock` is FIFO with no owner tracking — a claim taken inside the
 * ordinary run would queue behind a tail that cannot settle until that run
 * returns. That is a permanent deadlock on first login, so the test for it
 * races against a timeout rather than asserting directly: a plain assertion
 * would hang the suite instead of failing it.
 */

const mockRunManualSync = jest.fn()
const mockSyncDB = jest.fn()
const mockGetLastPulledAt = jest.fn()
const mockSignIn = jest.fn()
const mockSignOut = jest.fn()
const mockDeactivate = jest.fn()
let mockActivePeers: { id: string; peerType: string; metadata?: { url: string } }[] = []
let mockPeerCalls = 0

jest.mock("@/db", () => ({ __esModule: true, default: {} }))

jest.mock("@nozbe/watermelondb/sync", () => ({
  hasUnsyncedChanges: jest.fn(async () => false),
}))

jest.mock("@nozbe/watermelondb/sync/impl", () => ({
  getLastPulledAt: (...a: unknown[]) => mockGetLastPulledAt(...a),
}))

jest.mock("@/db/cloudManualSync", () => ({
  runManualSync: (...a: unknown[]) => mockRunManualSync(...a),
}))

jest.mock("@/db/peerSync", () => ({
  syncDB: (...a: unknown[]) => mockSyncDB(...a),
  getCredentials: async () => ({ email: "provider@example.com", password: "pw" }),
}))

jest.mock("@/models/Peer", () => ({
  __esModule: true,
  default: {
    DB: {
      // Staggered deliberately: the race this file guards only appears when two
      // callers' peer lookups take different times, which is what real database
      // I/O does and what a mock resolving in a fixed number of microtasks never
      // does. With a constant delay the guard test passes either way.
      getActive: async () => {
        mockPeerCalls++
        await new Promise((resolve) => setTimeout(resolve, mockPeerCalls === 1 ? 30 : 0))
        return mockActivePeers
      },
      deactivatePeersById: (...a: unknown[]) => mockDeactivate(...a),
    },
    // Mirrors the real `Peer.getUrl`: the backfill authenticates against the
    // peer it was handed, so sign-in needs this to resolve.
    getUrl: (peer: { metadata?: { url?: string } }) => peer?.metadata?.url ?? null,
  },
}))

jest.mock("@/models/User", () => ({
  __esModule: true,
  default: {
    signIn: (...a: unknown[]) => mockSignIn(...a),
    signOut: (...a: unknown[]) => mockSignOut(...a),
  },
}))

jest.mock("@/models/Sync", () => ({
  __esModule: true,
  default: { State: { IDLE: "idle" } },
}))

jest.mock("react-native-root-toast", () => ({
  __esModule: true,
  default: {
    show: jest.fn(),
    positions: { BOTTOM: 0 },
    durations: { LONG: 0 },
  },
}))

jest.mock("@sentry/react-native", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}))

jest.mock("@hikmahealth/js-utils", () => ({
  Logger: { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { withSyncLock } from "@/services/syncLock"
import { startSync } from "@/services/syncService"

/**
 * The real `runManualSync` claims the sync lock itself. Mocking that away would
 * make the deadlock test unable to reproduce the very thing it exists to catch,
 * so every stubbed run claims the lock exactly as the real one does.
 */
const backfillReturning = (result: unknown, delayMs = 0) =>
  jest.fn(() =>
    withSyncLock(
      "manual",
      () =>
        new Promise((resolve) =>
          delayMs > 0 ? setTimeout(() => resolve(result), delayMs) : resolve(result),
        ),
    ),
  )

const OK_RESULT = { ok: true, recordsPushed: 0, recordsApplied: 5_000, rejected: {} }

const CLOUD_PEER = {
  id: "cloud-1",
  peerType: "cloud_server",
  metadata: { url: "https://cloud.example.org" },
}
const HUB_PEER = { id: "hub-1", peerType: "sync_hub", metadata: { url: "http://192.168.1.9:4001" } }

beforeEach(() => {
  jest.clearAllMocks()
  mockActivePeers = [CLOUD_PEER]
  mockPeerCalls = 0
  mockGetLastPulledAt.mockResolvedValue(null)
  mockRunManualSync.mockImplementation(backfillReturning(OK_RESULT))
  mockSyncDB.mockResolvedValue(undefined)
  mockSignIn.mockResolvedValue(undefined)
  mockDeactivate.mockResolvedValue(undefined)
})

describe("first sync routing", () => {
  it("backfills when the device has never synced", async () => {
    await startSync("provider@example.com")

    expect(mockRunManualSync).toHaveBeenCalledTimes(1)
    expect(mockRunManualSync.mock.calls[0][0]).toMatchObject({ peerId: "cloud-1", since: 0 })
  })

  // Sign-in used to resolve its host from the active peer, which prefers a
  // hub — so a dual-paired device authenticated against a host with no /api
  // routes while syncing the cloud. The host comes from the peer being synced.
  it("authenticates against the cloud peer's own url", async () => {
    await startSync("provider@example.com")

    expect(mockSignIn).toHaveBeenCalledTimes(1)
    expect(mockSignIn.mock.calls[0][2]).toBe("https://cloud.example.org")
  })

  // The fallback is a second chance, not a replacement. A device whose backfill
  // succeeds must not then pull everything again unpaged.
  it("does not run the ordinary path when the backfill succeeds", async () => {
    await startSync("provider@example.com")

    expect(mockSyncDB).not.toHaveBeenCalled()
  })

  it("refreshes the provider record first, as the ordinary path does", async () => {
    await startSync("provider@example.com")

    expect(mockSignIn).toHaveBeenCalled()
  })

  // A watermark of 0 means "synced, everything since epoch" — not "never
  // synced". Collapsing null to 0 would backfill those devices every launch.
  it("does not backfill a device whose watermark is genuinely 0", async () => {
    mockGetLastPulledAt.mockResolvedValue(0)

    await startSync("provider@example.com")

    expect(mockRunManualSync).not.toHaveBeenCalled()
    expect(mockSyncDB).toHaveBeenCalled()
  })

  it("does not backfill a device that has synced", async () => {
    mockGetLastPulledAt.mockResolvedValue(1_700_000_000_000)

    await startSync("provider@example.com")

    expect(mockRunManualSync).not.toHaveBeenCalled()
    expect(mockSyncDB).toHaveBeenCalled()
  })

  it("leaves a hub-paired device on the ordinary path", async () => {
    mockActivePeers = [HUB_PEER]

    await startSync("provider@example.com")

    expect(mockRunManualSync).not.toHaveBeenCalled()
    expect(mockSyncDB).toHaveBeenCalled()
  })

  // Without the fallback a failed backfill leaves the device with nothing,
  // where the ordinary path might simply have worked. Falling through is the
  // behaviour every device has today, so it cannot be worse than the status quo.
  it("falls back to the ordinary path when the backfill fails", async () => {
    mockRunManualSync.mockImplementation(
      backfillReturning({ ok: false, error: "network", resumable: true }),
    )

    await startSync("provider@example.com")

    expect(mockRunManualSync).toHaveBeenCalledTimes(1)
    expect(mockSyncDB).toHaveBeenCalled()
  })

  it("falls back when the backfill throws rather than returning a failure", async () => {
    mockRunManualSync.mockImplementation(() =>
      withSyncLock("manual", async () => {
        throw new Error("boom")
      }),
    )

    await startSync("provider@example.com")

    expect(mockSyncDB).toHaveBeenCalled()
  })

  // The lock is FIFO with no owner tracking. A claim taken inside runSync would
  // queue behind a tail that cannot settle until runSync returns.
  it("does not deadlock — resolves rather than hanging", async () => {
    await expect(
      Promise.race([
        startSync("provider@example.com").then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
      ]),
    ).resolves.toBe("settled")
  })

  // syncService.ts:97-101 keeps the in-flight assignment free of any await so
  // racing callers join. Resolving the first-sync peer before that check
  // reopens the race — verified by moving it and watching this go to 2.
  it("two callers in the same tick produce one backfill", async () => {
    await Promise.all([startSync("provider@example.com"), startSync("provider@example.com")])

    expect(mockRunManualSync).toHaveBeenCalledTimes(1)
  })

  // An automatic trigger gives up when something else holds the lock. That
  // check must still happen before any of the first-sync work.
  it("an auto trigger still skips when a sync is already in flight", async () => {
    mockRunManualSync.mockImplementation(backfillReturning(OK_RESULT, 50))

    const first = startSync("provider@example.com")
    await startSync("provider@example.com", { trigger: "auto" })
    await first

    expect(mockRunManualSync).toHaveBeenCalledTimes(1)
  })
})
