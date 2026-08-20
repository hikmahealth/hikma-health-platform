import * as SecureStorage from "expo-secure-store"
import { CommonActions } from "@react-navigation/native"
import { Option } from "effect"

import { navigationRef } from "@/navigators/navigationUtilities"
import { providerStore } from "@/store/provider"
import UserClinicPermissions from "./UserClinicPermissions"
import database from "@/db"
import UserModel from "@/db/model/User"
import { Q } from "@nozbe/watermelondb"
import { LoginResponse } from "@/rpc/types"
import { Logger } from "@hikmahealth/js-utils"

namespace User {
  export const Roles = {
    ADMIN: "admin",
    PROVIDER: "provider",
  }
  export type Role = (typeof Roles)[keyof typeof Roles]
  export type T = {
    id: string
    name: string
    email: string
    role: Option.Option<Role>
    isDeleted: boolean
    createdAt: Date
    updatedAt: Date
    deletedAt: Option.Option<Date>
  }

  export type Provider = {
    id: string
    name: string
    email: string
    role: Option.Option<Role>
    instance_url: Option.Option<string>
    clinic_id: Option.Option<string>
    clinic_name: Option.Option<string>
    permissions: Option.Option<
      Pick<
        UserClinicPermissions.T,
        | "canRegisterPatients"
        | "canViewHistory"
        | "canEditRecords"
        | "canDeleteRecords"
        | "isClinicAdmin"
      >
    >
  }

  /** Default empty User Item */
  export const empty: T = {
    id: "",
    name: "",
    email: "",
    role: Option.none(),
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: Option.none(),
  }

  /**
   * Sign in against a cloud server. Hub-paired devices go through
   * `setFromHubLogin` instead.
   *
   * `apiUrl` is a parameter because the only lookup available,
   * `Peer.getActiveUrl()`, prefers the hub — which serves no `/api` routes —
   * and deactivates the cloud peer on the way past.
   */
  export const signIn = async (
    email: string,
    password: string,
    apiUrl: string,
  ): Promise<Provider> => {
    if (!apiUrl) {
      throw new Error("Invalid API URL")
    }

    if (email.length < 4 || password.length < 4) {
      throw new Error("Invalid email or password")
    }

    try {
      const endpoint = `${apiUrl}/api/login`
      Logger.log({ email, endpoint })
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      })
      Logger.log({ response: response.status })

      const result = await response.json()

      Logger.log({ msg: "Result:", result })

      if (response.status === 200 && result.message === undefined) {
        // Store credentials securely (for offline sync + fallback)
        await SecureStorage.setItemAsync("provider_password", password)
        await SecureStorage.setItemAsync("provider_email", email)

        // /api/login already returns the Bearer token for online-mode tRPC calls
        if (result.token) {
          await SecureStorage.setItemAsync("provider_token", result.token)
          Logger.log("[User.signIn] Bearer token stored")
        } else {
          Logger.warn("[User.signIn] No token in response — online tRPC writes may not work")
        }

        Logger.log("🚩🚩 Set from Cloud Login")
        providerStore.send({
          type: "set_provider",
          id: result.id,
          name: result.name,
          email: result.email,
          role: Option.fromNullable(result.role),
          instance_url: Option.fromNullable(result.instance_url),
          clinic_id: Option.fromNullable(result.clinic_id),
          clinic_name: Option.fromNullable(result.clinic_name),
        })

        return {
          id: result.id,
          name: result.name,
          email: result.email,
          role: Option.fromNullable(result.role),
          instance_url: Option.fromNullable(result.instance_url),
          clinic_id: Option.fromNullable(result.clinic_id),
          clinic_name: Option.fromNullable(result.clinic_name),
        }
      } else {
        throw new Error("Invalid credentials")
      }
    } catch (e) {
      Logger.error(e)
      throw e
    }
  }

  /**
   * Set user from a hub login response (no HTTP calls — hub already authenticated).
   * Stores credentials and token, updates providerStore.
   */
  export const setFromHubLogin = async (
    response: LoginResponse,
    email: string,
    password: string,
  ): Promise<Provider> => {
    // Store credentials for session restore
    await SecureStorage.setItemAsync("provider_email", email)
    await SecureStorage.setItemAsync("provider_password", password)
    await SecureStorage.setItemAsync("provider_token", response.token)

    const provider: Provider = {
      id: response.user_id,
      name: response.provider_name ?? "",
      email: response.email ?? email,
      role: Option.fromNullable(response.role as Role),
      instance_url: Option.none(),
      clinic_id: Option.fromNullable(response.clinic_id),
      clinic_name: Option.none(),
    }

    Logger.log("🚩🚩 Set from Hub Login")
    Logger.log({ provider })

    providerStore.send({ type: "set_provider", ...provider })
    return provider
  }

  /**
   * Sign out and return to the login screen.
   *
   * Reset navigation first: clearing the provider swaps in the auth stack, and a
   * screen removed natively but not from JS state desyncs the native stack.
   */
  export const signOut = async (): Promise<void> => {
    await SecureStorage.deleteItemAsync("provider_password")
    await SecureStorage.deleteItemAsync("provider_email")
    await SecureStorage.deleteItemAsync("provider_token")

    if (navigationRef.isReady()) {
      navigationRef.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [{ name: "Patients" }],
        }),
      )
    }

    providerStore.trigger.reset()
  }

  export namespace DB {
    /**
     * Given a user id, return the user data
     * @param {string} id
     * @returns {Promise<UserModel>}
     */
    export async function getById(id: string): Promise<UserModel> {
      const user = await database.get<UserModel>("users").find(id)
      if (!user) throw new Error("User not found")
      return user
    }
  }
}

export default User
