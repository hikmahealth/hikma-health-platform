/**
 * `Peer.Hub.refreshToken` — recovery from an expired hub session token, which
 * nothing else renews.
 *
 * The load-bearing detail is that the token lives in two places:
 * `HubSession.token`, which `syncHub` sends, and `provider_token`, which the
 * rest of the app reads. A refresh that wrote only one would leave the two
 * halves of the app disagreeing about who is signed in.
 */

const store: Record<string, string> = {}

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => store[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    store[key] = value
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete store[key]
  }),
}))

jest.mock("@/db", () => ({ __esModule: true, default: {}, database: {} }))

jest.mock("@sentry/react-native", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}))

const mockLogin = jest.fn()
jest.mock("@/rpc/transport", () => ({
  createEncryptedTransport: () => ({ login: mockLogin }),
}))

import Peer from "@/models/Peer"

/** A stored hub session, as `Peer.Session.save` would have written it. */
const seedSession = (token: string | null) => {
  store.hub_session = JSON.stringify({
    hubUrl: "http://192.168.1.5:4001",
    hubId: "hub-1",
    clientId: "client-1",
    sharedKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    token,
  })
}

const storedSessionToken = (): string | null =>
  store.hub_session ? JSON.parse(store.hub_session).token : null

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key]
  mockLogin.mockReset()
})

describe("Peer.Hub.refreshToken", () => {
  it("writes the new token to both the hub session and provider_token", async () => {
    seedSession("stale")
    store.provider_email = "a@b.c"
    store.provider_password = "pw"
    store.provider_token = "stale"
    mockLogin.mockResolvedValue({ ok: true, data: { token: "fresh" } })

    await expect(Peer.Hub.refreshToken()).resolves.toBe(true)

    expect(mockLogin).toHaveBeenCalledWith("a@b.c", "pw")
    // The one sync actually sends.
    expect(storedSessionToken()).toBe("fresh")
    // The one the rest of the app reads.
    expect(store.provider_token).toBe("fresh")
  })

  it("reports failure without calling the hub when no credentials are stored", async () => {
    seedSession("stale")

    await expect(Peer.Hub.refreshToken()).resolves.toBe(false)
    expect(mockLogin).not.toHaveBeenCalled()
  })

  it("reports failure when the device is not paired with a hub", async () => {
    store.provider_email = "a@b.c"
    store.provider_password = "pw"

    await expect(Peer.Hub.refreshToken()).resolves.toBe(false)
    expect(mockLogin).not.toHaveBeenCalled()
  })

  // Every failure below leaves the existing token in place. A hub that is
  // merely unreachable must not cost the provider their session mid-shift.
  it("leaves both tokens alone when the hub refuses", async () => {
    seedSession("stale")
    store.provider_email = "a@b.c"
    store.provider_password = "pw"
    store.provider_token = "stale"
    mockLogin.mockResolvedValue({ ok: false, error: { code: "AUTH_FAILED", message: "nope" } })

    await expect(Peer.Hub.refreshToken()).resolves.toBe(false)
    expect(storedSessionToken()).toBe("stale")
    expect(store.provider_token).toBe("stale")
  })

  it("treats a successful login carrying no token as a failure", async () => {
    seedSession("stale")
    store.provider_email = "a@b.c"
    store.provider_password = "pw"
    mockLogin.mockResolvedValue({ ok: true, data: {} })

    await expect(Peer.Hub.refreshToken()).resolves.toBe(false)
    expect(storedSessionToken()).toBe("stale")
  })

  it("returns false rather than throwing when the hub is unreachable", async () => {
    seedSession("stale")
    store.provider_email = "a@b.c"
    store.provider_password = "pw"
    mockLogin.mockRejectedValue(new Error("Network request failed"))

    await expect(Peer.Hub.refreshToken()).resolves.toBe(false)
    expect(storedSessionToken()).toBe("stale")
  })
})
