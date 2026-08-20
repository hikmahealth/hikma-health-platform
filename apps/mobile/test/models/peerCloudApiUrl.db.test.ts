/**
 * `Peer.getCloudApiUrl` against a real WatermelonDB instance.
 *
 * It picks the host for form-file uploads and attachment downloads, whose
 * endpoints exist on the cloud server only. `getActiveUrl` prefers the hub,
 * which is why these paths must not use it.
 */

import { createTestDatabase, resetTestDatabase } from "../helpers/testDatabase"

jest.mock("@/db", () => ({
  __esModule: true,
  get default() {
    return (global as never as { __TEST_DB__: unknown }).__TEST_DB__
  },
  get database() {
    return (global as never as { __TEST_DB__: unknown }).__TEST_DB__
  },
}))

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}))

jest.mock("@sentry/react-native", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureEvent: jest.fn(),
}))

import Peer from "@/models/Peer"

let testDb: ReturnType<typeof createTestDatabase>

const seed = async (peer: {
  peerType: string
  status: string
  url?: string
  ipAddress?: string
  port?: number
  name?: string
}): Promise<void> => {
  const collection = testDb.get("peers")
  await testDb.write(async () => {
    await collection.create((rec: never) => {
      const r = rec as unknown as Record<string, unknown>
      r.peerId = `${peer.peerType}-${peer.status}-${peer.url ?? peer.ipAddress ?? "x"}`
      r.name = peer.name ?? "Test server"
      r.peerType = peer.peerType
      r.status = peer.status
      r.ipAddress = peer.ipAddress ?? null
      r.port = peer.port ?? null
      r.metadata = peer.url ? { url: peer.url } : {}
    })
  })
}

beforeEach(() => {
  testDb = createTestDatabase()
  ;(global as never as { __TEST_DB__: unknown }).__TEST_DB__ = testDb
})

afterEach(async () => {
  await resetTestDatabase(testDb)
})

describe("Peer.getCloudApiUrl", () => {
  it("returns nothing when no peer is registered", async () => {
    expect(await Peer.getCloudApiUrl()).toBeNull()
  })

  it("returns the cloud server url", async () => {
    await seed({ peerType: "cloud_server", status: "active", url: "https://api.test" })

    expect(await Peer.getCloudApiUrl()).toBe("https://api.test")
  })

  // The reported failure on hub deployments: `getActiveUrl` hands back the hub,
  // and the upload lands on a route the hub does not serve.
  it("returns nothing for a device paired only with a local hub", async () => {
    await seed({ peerType: "sync_hub", status: "active", ipAddress: "192.168.1.5", port: 4001 })

    expect(await Peer.getCloudApiUrl()).toBeNull()
  })

  // Pairing a hub demotes the cloud peer to inactive, but that means "not the
  // current sync target" — an upload is not a sync.
  it("returns an inactive cloud server when a hub is the active sync peer", async () => {
    await seed({ peerType: "sync_hub", status: "active", ipAddress: "192.168.1.5", port: 4001 })
    await seed({ peerType: "cloud_server", status: "inactive", url: "https://api.test" })

    expect(await Peer.getCloudApiUrl()).toBe("https://api.test")
  })

  it("prefers an active cloud server over an inactive one", async () => {
    await seed({ peerType: "cloud_server", status: "inactive", url: "https://old.test" })
    await seed({ peerType: "cloud_server", status: "active", url: "https://current.test" })

    expect(await Peer.getCloudApiUrl()).toBe("https://current.test")
  })

  // A revoked server is one we are no longer permitted to talk to, and these
  // requests carry a bearer token.
  it.each(["revoked", "untrusted"])("never returns a %s cloud server", async (status) => {
    await seed({ peerType: "cloud_server", status, url: "https://api.test" })

    expect(await Peer.getCloudApiUrl()).toBeNull()
  })

  // `getUrl` falls back to a bare `host:port`. Uploads put a credential on this
  // url, so anything that is not HTTPS is refused.
  it("refuses a cloud peer that has no https url", async () => {
    await seed({ peerType: "cloud_server", status: "active", ipAddress: "10.0.0.9", port: 8080 })

    expect(await Peer.getCloudApiUrl()).toBeNull()
  })

  it("refuses a plain-http cloud peer", async () => {
    await seed({ peerType: "cloud_server", status: "active", url: "http://api.test" })

    expect(await Peer.getCloudApiUrl()).toBeNull()
  })
})
