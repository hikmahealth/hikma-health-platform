/**
 * Pluggable transport abstraction for RPC communication.
 *
 * Both hub (AES-GCM encrypted over HTTP) and cloud (plain JSON over HTTPS)
 * implement the same RpcTransport interface. This allows the rpcProvider
 * to work identically with either backend.
 */

import { classifyHttpStatus } from "./types"
import type { RpcResult, RpcError, LoginResponse } from "./types"
import type { HubSession } from "./handshake"
import { encryptForWire, decryptFromWire } from "./wire"
import { Logger } from "@hikmahealth/js-utils"

/**
 * Transport defines how command/query payloads are sent and received.
 * Hub: AES-GCM encrypted payloads over HTTP
 * Cloud: plain JSON with Bearer auth over HTTPS
 */
export type RpcTransport = {
  sendCommand: <T>(command: string, data: object, token?: string) => Promise<RpcResult<T>>
  sendQuery: <T>(query: string, params: object, token?: string) => Promise<RpcResult<T>>
  login: (email: string, password: string) => Promise<RpcResult<LoginResponse>>
  heartbeat: () => Promise<boolean>
}

function rpcError(code: RpcError["code"], message: string): RpcResult<never> {
  return { ok: false, error: { code, message } }
}

/**
 * Read an error out of a hub response envelope, or null when there isn't one.
 *
 * A hub failure arrives as HTTP 200 with a plaintext `error` and an empty
 * `payload`, so decrypting it reports "Failed to decrypt" and loses the real
 * message. A hub too old to send `error_code` degrades to SERVER_ERROR.
 */
function hubEnvelopeError(json: { error?: string; error_code?: string }): RpcResult<never> | null {
  if (!json?.error) return null
  return json.error_code === "AUTH_FAILED"
    ? rpcError("AUTH_FAILED", json.error)
    : rpcError("SERVER_ERROR", json.error)
}

/**
 * Create an encrypted transport for hub communication.
 * Encrypts request payloads with AES-GCM, decrypts responses.
 */
export function createEncryptedTransport(session: HubSession): RpcTransport {
  const { hubUrl, clientId, sharedKey, token: sessionToken } = session

  return {
    async sendCommand<T>(
      command: string,
      data: object,
      token = sessionToken,
    ): Promise<RpcResult<T>> {
      try {
        const body = encryptForWire(sharedKey, clientId, { command, data, token }, "command")
        const response = await fetch(`${hubUrl}/rpc/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!response.ok) {
          if (response.status === 401) return rpcError("AUTH_FAILED", "Unauthorized")
          return rpcError("NETWORK_ERROR", `HTTP ${response.status}`)
        }
        const json = await response.json()
        const envelopeError = hubEnvelopeError(json)
        if (envelopeError) return envelopeError
        const decrypted = decryptFromWire(sharedKey, json.payload, "command_response")
        if (!decrypted) return rpcError("DECRYPTION_FAILED", "Failed to decrypt command response")
        return { ok: true, data: decrypted as T }
      } catch (e) {
        return rpcError("NETWORK_ERROR", String(e))
      }
    },

    async sendQuery<T>(query: string, params: object, token = sessionToken): Promise<RpcResult<T>> {
      try {
        const body = encryptForWire(sharedKey, clientId, { query, params, token }, "query")
        const response = await fetch(`${hubUrl}/rpc/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        Logger.info({
          msg: "[RpcTransport:hub] sendQuery response received",
          query,
          status: response.status,
        })
        if (!response.ok) {
          if (response.status === 401) {
            Logger.warn({
              msg: "[RpcTransport:hub] sendQuery auth failed",
              query,
              status: response.status,
            })
            return rpcError("AUTH_FAILED", "Unauthorized")
          }
          Logger.warn({
            msg: "[RpcTransport:hub] sendQuery HTTP error",
            query,
            status: response.status,
          })
          return rpcError("NETWORK_ERROR", `HTTP ${response.status}`)
        }
        const json = await response.json()
        const envelopeError = hubEnvelopeError(json)
        if (envelopeError) {
          Logger.warn({ msg: "[RpcTransport:hub] sendQuery rejected", query, error: envelopeError })
          return envelopeError
        }
        const decrypted = decryptFromWire(sharedKey, json.payload, "query_response")
        if (!decrypted) {
          Logger.error({ msg: "[RpcTransport:hub] sendQuery decryption failed", query })
          return rpcError("DECRYPTION_FAILED", "Failed to decrypt query response")
        }
        Logger.info({ msg: "[RpcTransport:hub] sendQuery completed successfully", query })
        return { ok: true, data: decrypted as T }
      } catch (e) {
        Logger.error({ msg: "[RpcTransport:hub] sendQuery exception", query, error: String(e) })
        return rpcError("NETWORK_ERROR", String(e))
      }
    },

    async login(email: string, password: string): Promise<RpcResult<LoginResponse>> {
      return this.sendCommand<LoginResponse>("login", { email, password })
    },

    async heartbeat(): Promise<boolean> {
      try {
        const response = await fetch(`${hubUrl}/rpc/heartbeat`, { method: "GET" })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

/**
 * Cloud transport speaking tRPC's HTTP contract.
 *
 * Queries are GET with superjson-wrapped input in `?input=`; commands are POST
 * with a superjson-wrapped body. Procedure names are dotted path segments
 * (`sync.backfillPull`), not a `command` field. Auth is Bearer only.
 */
export function createTrpcCloudTransport(
  baseUrl: string,
  getAuth: () => string | Promise<string>,
): RpcTransport {
  const failure = (
    code: RpcError["code"],
    message: string,
    extra: Partial<RpcError> = {},
  ): RpcResult<never> => ({ ok: false, error: { code, message, ...extra } })

  /**
   * The human-readable half of a tRPC error envelope, or the raw body.
   *
   * A tRPC error carries `data.stack` with absolute server paths. Passing the
   * whole body through as the message ships those into mobile logs and Sentry,
   * so the envelope's own `message` is preferred whenever it parses.
   */
  const errorMessage = (body: string): string => {
    try {
      const parsed = JSON.parse(body)
      const message = parsed?.error?.json?.message ?? parsed?.error?.message
      if (typeof message === "string" && message.length > 0) return message
    } catch {
      // Not JSON — the raw body is the best available message.
    }
    return body
  }

  /** Map a non-ok Response onto a classified RpcError. */
  const fromResponse = async (response: Response): Promise<RpcResult<never>> => {
    const { code, retryable } = classifyHttpStatus(response.status)
    // A 429 from the rate limiter is a plain body, not a tRPC envelope, so the
    // header is the only place the delay exists. Absent or unparseable, omit it
    // rather than passing NaN to a caller that would treat it as "retry now".
    const retryAfterSeconds = Number(response.headers?.get?.("Retry-After"))
    const body = await response.text().catch(() => "")
    return failure(code, errorMessage(body) || `HTTP ${response.status}`, {
      retryable,
      status: response.status,
      ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? { retryAfterMs: retryAfterSeconds * 1000 }
        : {}),
    })
  }

  /**
   * Unwrap `{result:{data:{json: T}}}`, or surface `{error:{json:{message}}}`.
   *
   * The `json` half is returned as-is, with its sibling `meta` discarded: dates
   * stay ISO strings rather than becoming `Date`s. `superjson` is not a declared
   * mobile dependency, and `updateDates` already normalises ISO to the epoch
   * numbers WatermelonDB stores — deserialising here would only add a second
   * conversion back.
   *
   * A tRPC-level error is terminal: the request was understood and refused.
   */
  const unwrap = <T>(payload: any): RpcResult<T> => {
    if (payload?.error) {
      const message = payload.error?.json?.message ?? payload.error?.message ?? "RPC error"
      return failure("BAD_REQUEST", String(message), { retryable: false })
    }
    const data = payload?.result?.data
    // Membership, not a nullish fallback: a procedure returning null yields
    // `{json: null}`, and `??` would hand back the wrapper instead of the null.
    const hasEnvelope = data !== null && typeof data === "object" && "json" in data
    return { ok: true, data: (hasEnvelope ? data.json : data) as T }
  }

  const authHeaders = async (): Promise<Record<string, string>> => ({
    Authorization: await getAuth(),
  })

  return {
    async sendQuery<T>(query: string, params: object): Promise<RpcResult<T>> {
      try {
        const input = encodeURIComponent(JSON.stringify({ json: params }))
        const response = await fetch(`${baseUrl}/rpc/query/${query}?input=${input}`, {
          method: "GET",
          headers: await authHeaders(),
        })
        if (!response.ok) return fromResponse(response)
        return unwrap<T>(await response.json())
      } catch (e) {
        return failure("NETWORK_ERROR", String(e), { retryable: true })
      }
    },

    async sendCommand<T>(command: string, data: object): Promise<RpcResult<T>> {
      try {
        const response = await fetch(`${baseUrl}/rpc/command/${command}`, {
          method: "POST",
          headers: { ...(await authHeaders()), "Content-Type": "application/json" },
          body: JSON.stringify({ json: data }),
        })
        if (!response.ok) return fromResponse(response)
        return unwrap<T>(await response.json())
      } catch (e) {
        return failure("NETWORK_ERROR", String(e), { retryable: true })
      }
    },

    async login(email: string, password: string): Promise<RpcResult<LoginResponse>> {
      try {
        // No Authorization header: this is where the token comes from.
        const response = await fetch(`${baseUrl}/rpc/command/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { email, password } }),
        })
        if (!response.ok) return fromResponse(response)
        return unwrap<LoginResponse>(await response.json())
      } catch (e) {
        return failure("NETWORK_ERROR", String(e), { retryable: true })
      }
    },

    async heartbeat(): Promise<boolean> {
      try {
        const response = await fetch(`${baseUrl}/rpc/query/heartbeat`, {
          method: "GET",
          headers: await authHeaders(),
        })
        return response.ok
      } catch {
        return false
      }
    },
  }
}
