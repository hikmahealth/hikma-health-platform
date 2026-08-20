import { createEncryptedTransport } from "../../app/rpc/transport"
import { encryptForWire, decryptFromWire } from "../../app/rpc/wire"
import { seal } from "../../app/crypto/cipher"
import { encode, utf8Encode } from "../../app/crypto/encoding"
import { randomBytes } from "@noble/ciphers/utils.js"
import type { HubSession } from "../../app/rpc/handshake"
import type { LoginResponse } from "../../app/rpc/types"

// Mock global fetch
const mockFetch = jest.fn()
global.fetch = mockFetch

function createMockSession(): HubSession {
  return {
    hubUrl: "http://192.168.1.100:8080",
    hubId: "hub-123",
    clientId: "client-456",
    sharedKey: randomBytes(32),
    token: "test-token",
  }
}

/** Helper: encrypt a response payload that the hub would send back */
function encryptResponse(
  key: Uint8Array,
  data: object,
  aad: "command_response" | "query_response",
) {
  const plaintext = utf8Encode(JSON.stringify(data))
  const sealed = seal(key, plaintext, aad)
  return { payload: encode(sealed) }
}

describe("createEncryptedTransport", () => {
  beforeEach(() => mockFetch.mockReset())

  it("sendCommand encrypts request and decrypts response", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)
    const responseData = { id: "123", success: true }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => encryptResponse(session.sharedKey, responseData, "command_response"),
    })

    const result = await transport.sendCommand("patients.create", { name: "Test" }, "token")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual(responseData)

    // Verify fetch was called with the right URL
    expect(mockFetch).toHaveBeenCalledWith(
      `${session.hubUrl}/rpc/command`,
      expect.objectContaining({ method: "POST" }),
    )

    // Verify the request body is encrypted (contains client_id and payload)
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callBody.client_id).toBe(session.clientId)
    expect(typeof callBody.payload).toBe("string")

    // Verify we can decrypt what was sent
    const decrypted = decryptFromWire(session.sharedKey, callBody.payload, "command")
    expect(decrypted).toMatchObject({ command: "patients.create", data: { name: "Test" } })
  })

  it("sendQuery encrypts request and decrypts response", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)
    const responseData = [{ id: "1", name: "Patient 1" }]

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => encryptResponse(session.sharedKey, responseData, "query_response"),
    })

    const result = await transport.sendQuery("get_patients", { limit: 10 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual(responseData)

    expect(mockFetch).toHaveBeenCalledWith(
      `${session.hubUrl}/rpc/query`,
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("login sends encrypted login command", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)
    const loginData: LoginResponse = {
      token: "jwt-token",
      user_id: "user-1",
      clinic_id: "clinic-1",
      role: "provider",
      name: "Test User",
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => encryptResponse(session.sharedKey, loginData, "command_response"),
    })

    const result = await transport.login("test@example.com", "password123")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual(loginData)
  })

  it("heartbeat returns true on success", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)

    mockFetch.mockResolvedValueOnce({ ok: true })
    expect(await transport.heartbeat()).toBe(true)

    expect(mockFetch).toHaveBeenCalledWith(
      `${session.hubUrl}/rpc/heartbeat`,
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("network error returns NETWORK_ERROR", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)

    mockFetch.mockRejectedValueOnce(new Error("Network failure"))
    const result = await transport.sendCommand("test", {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("NETWORK_ERROR")
  })
})

/**
 * Hub failures arrive as HTTP 200 with a plaintext `error` and an empty
 * `payload`. The transport used to hand that payload straight to the decryptor,
 * so every hub error reached the user as "Failed to decrypt".
 */
describe("createEncryptedTransport — hub error envelopes", () => {
  beforeEach(() => mockFetch.mockReset())

  const envelope = (body: object) => ({ ok: true, json: async () => body })

  const authFailure = {
    payload: "",
    success: false,
    error: "JWT verification failed: JWT token has expired",
    error_code: "AUTH_FAILED",
  }

  // The case the hub's 2-hour token makes routine. Sync answers AUTH_FAILED by
  // refreshing and retrying, so misreporting it strands the user.
  it.each(["sendQuery", "sendCommand"] as const)(
    "%s reports an expired token as AUTH_FAILED, not a decryption failure",
    async (method) => {
      const session = createMockSession()
      const transport = createEncryptedTransport(session)
      mockFetch.mockResolvedValueOnce(envelope(authFailure))

      const result = await transport[method]("sync_pull", {}, "stale-token")

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe("AUTH_FAILED")
        expect(result.error.message).toContain("expired")
      }
    },
  )

  // A validation or database error must not be read as an auth failure, or the
  // client refreshes its token and retries a request that cannot succeed.
  it("reports an untagged hub error as SERVER_ERROR, preserving the message", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)
    mockFetch.mockResolvedValueOnce(
      envelope({ payload: "", success: false, error: "Unknown query: no_such_query" }),
    )

    const result = await transport.sendQuery("no_such_query", {}, "token")

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("SERVER_ERROR")
      expect(result.error.message).toBe("Unknown query: no_such_query")
    }
  })

  // A hub older than `error_code` still reports its own words rather than a
  // decryption error, and still does not trigger a pointless token refresh.
  it("degrades to the hub's message when no error_code is present", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)
    mockFetch.mockResolvedValueOnce(
      envelope({ payload: "", success: false, error: "Authentication required" }),
    )

    const result = await transport.sendCommand("sync_push", {}, undefined)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toBe("Authentication required")
  })

  // The envelope check must not intercept healthy traffic.
  it("still decrypts a successful response", async () => {
    const session = createMockSession()
    const transport = createEncryptedTransport(session)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => encryptResponse(session.sharedKey, { changes: {} }, "query_response"),
    })

    const result = await transport.sendQuery("sync_pull", {}, "token")

    expect(result.ok).toBe(true)
  })
})
