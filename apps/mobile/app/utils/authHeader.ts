import { Buffer } from "buffer"
import * as SecureStore from "expo-secure-store"

import type { LoginResponse, RpcResult } from "@/rpc/types"
import { Logger } from "@hikmahealth/js-utils"

/**
 * Authorization header for provider-authenticated requests, or null when no
 * credential is stored. Basic is only a fallback: the server validates it with a
 * bcrypt compare and a new token row per request, where Bearer is one indexed lookup.
 */
export const getProviderAuthHeader = async (): Promise<string | null> => {
  const [token, email, password] = await Promise.all([
    SecureStore.getItemAsync("provider_token"),
    SecureStore.getItemAsync("provider_email"),
    SecureStore.getItemAsync("provider_password"),
  ])

  if (token) return `Bearer ${token}`
  if (email && password) {
    return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`
  }
  return null
}

/**
 * Authorization header for tRPC calls, or an empty string when no token is
 * cached.
 *
 * Deliberately without the Basic fallback above: tRPC's authedProcedure rejects
 * any scheme other than Bearer, so a Basic header is not a degraded credential
 * here, it is a guaranteed 401. Callers holding a transport should recover from
 * the empty case with `refreshBearerToken`.
 */
export const getBearerToken = async (): Promise<string> => {
  const token = await SecureStore.getItemAsync("provider_token")
  return token ? `Bearer ${token}` : ""
}

/**
 * Mint a fresh token from the stored credentials and cache it.
 *
 * Returns false when there is nothing to sign in with or the server refused,
 * leaving any existing token untouched — a failed refresh during a transient
 * outage must not escalate into a forced re-login. The transport is passed in
 * rather than constructed so the caller decides which host to authenticate
 * against.
 */
export const refreshBearerToken = async (transport: {
  login: (email: string, password: string) => Promise<RpcResult<LoginResponse>>
}): Promise<boolean> => {
  const [email, password] = await Promise.all([
    SecureStore.getItemAsync("provider_email"),
    SecureStore.getItemAsync("provider_password"),
  ])
  if (!email || !password) return false

  const result = await transport.login(email, password)
  if (!result.ok) return false
  if (!result.data?.token) return false

  await SecureStore.setItemAsync("provider_token", result.data.token)
  return true
}

/**
 * Mint a fresh session token over REST and cache it, for callers recovering
 * from a 401. Tokens expire after two hours while a tablet stays signed in all
 * shift, and `getProviderAuthHeader` falls back to Basic only when there is no
 * token at all — so a dead one shadows credentials that would still work.
 *
 * Separate from `refreshBearerToken`, which needs a tRPC transport the upload
 * and download paths never build.
 *
 * Returns null without touching the cached token when refresh fails.
 */
export const refreshProviderToken = async (apiUrl: string): Promise<string | null> => {
  const [email, password] = await Promise.all([
    SecureStore.getItemAsync("provider_email"),
    SecureStore.getItemAsync("provider_password"),
  ])
  if (!email || !password) return null

  try {
    const response = await fetch(`${apiUrl}/api/login`, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    if (response.status !== 200) return null

    const body = (await response.json()) as { token?: string } | null
    if (!body?.token) return null

    await SecureStore.setItemAsync("provider_token", body.token)
    return `Bearer ${body.token}`
  } catch (error) {
    Logger.warn({ msg: "Session refresh failed", error })
    return null
  }
}
