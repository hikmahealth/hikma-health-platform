import { Q } from "@nozbe/watermelondb"
import * as SecureStore from "expo-secure-store"
import { v4 as uuidv4 } from "uuid"

import database from "@/db"
import PeerModel from "@/db/model/Peer"
import { encode, decode } from "@/crypto/encoding"
import { performHandshake, type HubSession } from "@/rpc/handshake"
import { createEncryptedTransport, type RpcTransport } from "@/rpc/transport"
import type { RpcResult } from "@/rpc/types"
import { ok, err, type Result, type DataError } from "../../types/data"
import { logger } from "@/utils/logger"
import { checkUrl } from "@/utils/misc"
import { Logger } from "@hikmahealth/js-utils"

namespace Peer {
  export type T = {
    id: string
    peerId: string
    name: string
    ipAddress: string | null
    port: number | null
    publicKey: string
    lastSyncedAt: number | null
    peerType: PeerType
    isLeader: boolean
    status: PeerStatus
    protocolVersion: string
    metadata: PeerMetadata
    createdAt: Date
    updatedAt: Date
  }

  export type UpsertParams = {
    peerId: string
    name: string
    peerType: PeerType
    publicKey?: string
    ipAddress?: string
    port?: number
    url?: string
  }

  export type DBPeer = PeerModel

  /** Peer types are either the sync hub, a cloud server, or (future) a "mobile_app" to support P2P directly */
  export const peerTypes = ["sync_hub", "cloud_server"] as const
  export type PeerType = (typeof peerTypes)[number]
  /**
   * PeerStatus
   * active : This is the peer to that is ready to sync with
   * inactive : This peer will not be synced with, but it is verified and a valid peer
   * revoked : This peer is no longer permitted to be synced with, it may have been active in the past
   * untrusted : This peer is not trusted and should not be synced with at all. this is similar to a blacklist
   */
  export const peerStatuses = ["active", "inactive", "revoked", "untrusted"] as const
  export type PeerStatus = (typeof peerStatuses)[number]

  export type PeerMetadata = {
    [key: string]: unknown
  }

  /**
   * Where a paged manual sync got to, so an interrupted run resumes instead of
   * restarting. `snapshotTs` is the server's snapshot for the run — a resumed
   * page must carry it or it would read a moving target.
   */
  export type ResumeState = {
    cursor: string
    since: number
    snapshotTs: number
    pagesApplied: number
    recordsApplied: number
  }

  const RESUME_KEY = "manualSyncResume"

  /**
   * Merge resume state into a peer's metadata blob, or remove it when null.
   *
   * Metadata also carries the peer URL, so this merges rather than replaces —
   * dropping `url` would leave the peer unreachable. Returns a new object; the
   * caller passes a live record's `metadata` straight in.
   */
  export const mergeResumeState = (
    metadata: PeerMetadata,
    state: ResumeState | null,
  ): PeerMetadata => {
    const next = { ...(metadata ?? {}) } as Record<string, unknown>
    if (state === null) delete next[RESUME_KEY]
    else next[RESUME_KEY] = { ...state }
    return next as PeerMetadata
  }

  /**
   * Read resume state, tolerating absent or malformed blobs.
   *
   * Anything unreadable returns null, which restarts the run from the beginning.
   * That is always safe — the backfill is idempotent — whereas trusting a
   * half-written blob would send a bad cursor the server rejects outright.
   */
  export const readResumeState = (metadata: PeerMetadata): ResumeState | null => {
    const raw = (metadata as Record<string, unknown> | null)?.[RESUME_KEY]
    if (!raw || typeof raw !== "object") return null
    const s = raw as Record<string, unknown>
    // An empty cursor is not a position: the server rejects `cursor: ""` as
    // malformed, so treat it as absent and start over.
    if (typeof s.cursor !== "string" || s.cursor.length === 0) return null
    if (typeof s.since !== "number" || typeof s.snapshotTs !== "number") return null
    return {
      cursor: s.cursor,
      since: s.since,
      snapshotTs: s.snapshotTs,
      pagesApplied: typeof s.pagesApplied === "number" ? s.pagesApplied : 0,
      recordsApplied: typeof s.recordsApplied === "number" ? s.recordsApplied : 0,
    }
  }

  export const empty: T = {
    id: "",
    peerId: "",
    name: "",
    ipAddress: null,
    port: null,
    publicKey: "",
    lastSyncedAt: null,
    peerType: "cloud_server",
    isLeader: false,
    status: "untrusted",
    protocolVersion: "",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  export const fromDB = (db: DB.T): T => ({
    id: db.id,
    peerId: db.peerId,
    name: db.name,
    ipAddress: db.ipAddress,
    port: db.port,
    publicKey: db.publicKey,
    lastSyncedAt: db.lastSyncedAt,
    peerType: db.peerType,
    isLeader: db.isLeader,
    status: db.status,
    protocolVersion: db.protocolVersion,
    metadata: db.metadata,
    createdAt: db.createdAt,
    updatedAt: db.updatedAt,
  })

  export const displayName = (peer: T): string => peer.name || peer.peerId

  // DB operations

  export namespace DB {
    export type T = PeerModel
    export const table_name = "peers"

    const collection = () => database.get<T>(table_name)

    export const create = async (
      peer: Omit<Peer.T, "id" | "createdAt" | "updatedAt">,
    ): Promise<string> =>
      database.write(async () => {
        const record = await collection().create((rec) => {
          rec.peerId = peer.peerId
          rec.name = peer.name
          rec.ipAddress = peer.ipAddress
          rec.port = peer.port
          rec.publicKey = peer.publicKey
          rec.lastSyncedAt = peer.lastSyncedAt
          rec.peerType = peer.peerType
          rec.isLeader = peer.isLeader
          rec.status = peer.status
          rec.protocolVersion = peer.protocolVersion
          rec.metadata = peer.metadata ?? {}
        })
        return record.id
      })

    export const upsert = async (params: UpsertParams): Promise<void> => {
      const existing = await collection().query(Q.where("peer_id", params.peerId)).fetch()

      if (existing.length > 0) {
        await database.write(() =>
          existing[0].update((rec) => {
            rec.name = params.name
            rec.status = "active"
            if (params.publicKey) rec.publicKey = params.publicKey
            if (params.ipAddress) rec.ipAddress = params.ipAddress
            if (params.port !== undefined) rec.port = params.port
            if (params.url) rec.metadata = { ...rec.metadata, url: params.url }
          }),
        )
      } else {
        await database.write(() =>
          collection().create((rec) => {
            rec.peerId = params.peerId
            rec.name = params.name
            rec.peerType = params.peerType
            rec.publicKey = params.publicKey ?? ""
            rec.status = "active"
            rec.isLeader = false
            rec.protocolVersion = "1"
            rec.ipAddress = params.ipAddress ?? null
            rec.port = params.port ?? null
            rec.metadata = params.url ? { url: params.url } : {}
          }),
        )
      }
    }

    /**
     * Upsert a local sync hub to the list of peers
     * @returns Promise<string> where the string is the peerId
     */
    export const upsertHub = async (params: {
      hubId: string
      name: string
      publicKey: string
      ipAddress?: string
      port?: number
      url?: string
    }): Promise<string> => {
      await upsert({
        peerId: params.hubId,
        name: params.name,
        peerType: "sync_hub",
        publicKey: params.publicKey,
        ipAddress: params.ipAddress,
        port: params.port,
        url: params.url,
      })

      return params.hubId
    }

    // We currently do not allow 2 cloud peers to be registered at the same time.
    // If a cloud peer already exists, replace it with the new one.
    // HTTPS is required to prevent Basic Auth credentials from being sent in cleartext.
    /**
     *
     * @param url string
     * @returns Promise<string> where the string is the peerId
     */
    export const upsertCloud = async (url: string): Promise<string> => {
      if (!url.startsWith("https://")) {
        throw new Error("Cloud peer URL must use HTTPS")
      }
      const existing = await getActiveByType("cloud_server")
      for (const peer of existing) {
        if (peer.peerId !== `cloud:${url}`) {
          await database.write(() =>
            peer.update((rec) => {
              rec.status = "revoked"
            }),
          )
        }
      }
      const peerId = `cloud:${url}`
      await upsert({
        peerId,
        name: "Cloud Server",
        peerType: "cloud_server",
        url,
      })
      return peerId
    }

    export const getById = async (id: string): Promise<Peer.T> => {
      const record = await collection().find(id)
      return fromDB(record)
    }

    export const getByPeerId = async (peerId: string): Promise<Peer.T | null> => {
      const records = await collection().query(Q.where("peer_id", peerId), Q.take(1)).fetch()
      return records.length > 0 ? fromDB(records[0]) : null
    }

    /**
     * Returns all peers with a matching id, or matching peer_id fields
     * @param {string[]} peerIds
     * @returns {Promise<Peer.DBPeer[]>}
     */
    export const getAllByIds = async (peerIds: string[]): Promise<Peer.DBPeer[]> => {
      const peers = await collection()
        .query(Q.or(Q.where("id", Q.oneOf(peerIds)), Q.where("peerId", Q.oneOf(peerIds))))
        .fetch()

      return peers
    }

    export const getAll = async (): Promise<Peer.T[]> => {
      const records = await collection().query(Q.sortBy("created_at", Q.desc)).fetch()
      return records.map(fromDB)
    }

    /**
     * Gets the active peers in the peers database table.
     * @returns Promise<Peer.T[]> all peers with status being active
     */
    export const getActive = async (): Promise<Peer.T[]> => {
      const records = await collection()
        .query(Q.where("status", "active"), Q.sortBy("updated_at", Q.desc))
        .fetch()
      return records.map(fromDB)
    }

    export const getActiveByType = async (peerType: PeerType): Promise<DB.T[]> =>
      collection().query(Q.where("peer_type", peerType), Q.where("status", "active")).fetch()

    /** Resolve the active sync peer. Prefers hub, falls back to cloud. */
    export const resolveActive = async (): Promise<Peer.T | null> => {
      const hubs = await getActiveByType("sync_hub")
      if (hubs.length > 0) return fromDB(hubs[0])
      const clouds = await getActiveByType("cloud_server")
      if (clouds.length > 0) return fromDB(clouds[0])
      return null
    }

    export const getLeader = async (): Promise<Peer.T | null> => {
      const records = await collection()
        .query(Q.where("is_leader", true), Q.where("status", "active"), Q.take(1))
        .fetch()
      return records.length > 0 ? fromDB(records[0]) : null
    }

    /**
     * Given a list of peer ids, set all their statuses to "inactive"
     * @param {string[]} peerIds
     * @returns {Promise<void>}
     */
    export const deactivatePeersById = async (peerIds: string[]): Promise<void> => {
      if (peerIds.length === 0) return
      const peers = await getAllByIds(peerIds)
      await database.write(async () =>
        peers.map((it) =>
          it.update((db_rec) => {
            db_rec.status = "inactive"
          }),
        ),
      )
    }

    /**
     * Sets the status of a sync peer.
     * This also sets all other peers as inactive if they were active before
     * @param {string} id
     * @param {PeerStatus} status
     * @returns
     */
    export const updateStatus = async (id: string, status: PeerStatus): Promise<void> => {
      let valid_status: PeerStatus = status
      const allPeers = await getAll()
      const record = allPeers.find((it) => it.id === id || it.peerId === id)
      const activePeers = allPeers.filter((it) => it.status === "active")

      if (!record) {
        throw new Error("This peer record does not exist")
      }

      if (activePeers.length > 1) {
        Logger.log({ msg: "There are multiple peers registered at the same time in active status" })
        const peers_to_deactivate = activePeers
          .filter((it) => it.id !== record.id)
          .map((it) => it.id)

        // [SELF_HEALING] This operation should not block the rest of the work the user is doing. just log and move on.
        deactivatePeersById(peers_to_deactivate).catch((error) => {
          Logger.error({
            error,
            msg: "Failed to set a peer record to inactive that was active before",
          })
        })
      }

      if (record.status === status) {
        return Promise.resolve()
      }

      if (!peerStatuses.includes(status)) {
        Logger.error({
          msg: "The status is not recognized, defaulting to toggling between active and inactive for the peer",
          passedStatus: status,
        })
        switch (record.status) {
          case "active":
            valid_status = "inactive"
            break
          case "inactive":
            valid_status = "active"
            break
          default:
            valid_status = "untrusted"
        }
      }
      await database.write(async () => {
        const db_record = await collection().find(record.id)
        db_record.update((rec) => {
          rec.status = valid_status
        })
      })
    }

    export const revoke = async (peerId: string): Promise<void> => {
      const records = await collection().query(Q.where("peer_id", peerId)).fetch()
      if (records.length === 0) return
      await database.write(() =>
        records[0].update((rec) => {
          rec.status = "revoked"
        }),
      )
    }

    export const updateLastSyncedAt = async (id: string, timestamp: number): Promise<void> => {
      const record = await collection().find(id)
      await database.write(() =>
        record.update((rec) => {
          rec.lastSyncedAt = timestamp
        }),
      )
    }

    /** Record where a paged manual sync got to, so it can resume after an interruption. */
    export const saveResumeState = async (id: string, state: Peer.ResumeState): Promise<void> => {
      const record = await collection().find(id)
      await database.write(() =>
        record.update((rec) => {
          rec.metadata = Peer.mergeResumeState(rec.metadata, state)
        }),
      )
    }

    /**
     * Where the last manual sync got to, or null if there is nothing to resume.
     *
     * Returns null for a peer that no longer exists rather than throwing: a peer
     * deleted mid-run leaves nothing to resume, which is the same answer.
     */
    export const getResumeState = async (id: string): Promise<Peer.ResumeState | null> => {
      try {
        const record = await collection().find(id)
        return Peer.readResumeState(record.metadata)
      } catch {
        return null
      }
    }

    /** Drop resume state once a run completes or the user abandons it. */
    export const clearResumeState = async (id: string): Promise<void> => {
      const record = await collection().find(id)
      await database.write(() =>
        record.update((rec) => {
          rec.metadata = Peer.mergeResumeState(rec.metadata, null)
        }),
      )
    }

    export const deleteById = async (id: string): Promise<void> => {
      const record = await collection().find(id)
      await database.write(() => record.markAsDeleted())
    }

    export const subscribe = (callback: (peers: Peer.T[]) => void): { unsubscribe: () => void } => {
      const subscription = collection()
        .query(Q.where("status", Q.notEq("revoked")), Q.sortBy("created_at", Q.desc))
        .observe()
        .subscribe((records) => callback(records.map(fromDB)))
      return { unsubscribe: () => subscription.unsubscribe() }
    }

    export const subscribeById = (
      id: string,
      callback: (peer: Peer.T | null) => void,
    ): { unsubscribe: () => void } => {
      const subscription = collection()
        .findAndObserve(id)
        .subscribe(
          (record) => callback(fromDB(record)),
          () => callback(null),
        )
      return { unsubscribe: () => subscription.unsubscribe() }
    }
  }

  export namespace Session {
    const SESSION_KEY = "hub_session"
    const CLIENT_ID_KEY = "hub_client_id"

    type Serialized = {
      hubUrl: string
      hubId: string
      clientId: string
      sharedKey: string // base64url-encoded
      token: string | null
    }

    export const save = async (session: HubSession): Promise<void> => {
      const serialized: Serialized = {
        hubUrl: session.hubUrl,
        hubId: session.hubId,
        clientId: session.clientId,
        sharedKey: encode(session.sharedKey),
        token: session.token,
      }
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(serialized))
    }

    export const load = async (): Promise<HubSession | null> => {
      const raw = await SecureStore.getItemAsync(SESSION_KEY)
      if (!raw) return null
      try {
        const parsed: Serialized = JSON.parse(raw)
        return {
          hubUrl: parsed.hubUrl,
          hubId: parsed.hubId,
          clientId: parsed.clientId,
          hubName: `Peer: ${parsed.hubId}`,
          sharedKey: decode(parsed.sharedKey),
          token: parsed.token,
        }
      } catch {
        return null
      }
    }

    export const clear = async (): Promise<void> => {
      await SecureStore.deleteItemAsync(SESSION_KEY)
    }

    export const getOrCreateClientId = async (): Promise<string> => {
      const existing = await SecureStore.getItemAsync(CLIENT_ID_KEY)
      if (existing) return existing
      const id = uuidv4()
      await SecureStore.setItemAsync(CLIENT_ID_KEY, id)
      return id
    }

    export const getTokenByPeerId = async (peerId: string): Promise<Result<string>> => {
      const session = await load()
      logger.log("[getTokenByPeerId]: ", { session })
      if (!session) return err({ _tag: "NotFound", entity: "HubSession", id: peerId })
      if (session.hubId !== peerId)
        return err({
          _tag: "ValidationError",
          message: `Session peer ID mismatch: expected ${peerId}, got ${session.hubId}`,
        })
      if (!session.token) return err({ _tag: "NotFound", entity: "SessionToken", id: peerId })
      return ok(session.token)
    }
  }

  /** Extract the URL from a peer, preferring metadata.url, falling back to ipAddress:port. */
  export const getUrl = (peer: T): string | null => {
    const metadataUrl = peer.metadata?.url as string | undefined
    if (metadataUrl) return metadataUrl
    if (peer.ipAddress) {
      return peer.port ? `${peer.ipAddress}:${peer.port}` : peer.ipAddress
    }
    return null
  }

  /**
   * Resolve the active peer's URL, by peer priority: hub > cloud. Drop-in
   * replacement for the deprecated getHHApiUrl().
   */
  export const getActiveUrl = async (): Promise<string | null> => {
    const activePeers = await DB.getActive()

    if (activePeers.length === 0) return null

    if (activePeers.length === 1) {
      return getUrl(activePeers[0]) || null
    }

    // More than one active peer is an invalid state. Collapse to a single winner
    // and deactivate the rest. Preference: local hub (the primary field sync
    // target) over cloud server, then any active peer so we never return null
    // while peers are active. Within a kind, the most-recently-updated wins.
    const mostRecent = (peers: typeof activePeers): (typeof activePeers)[number] | undefined =>
      peers.length === 0
        ? undefined
        : [...peers].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )[0]

    const localServers = activePeers.filter((p) => p.peerType === "sync_hub")
    const cloudServers = activePeers.filter((p) => p.peerType === "cloud_server")

    const winner = mostRecent(localServers) ?? mostRecent(cloudServers) ?? mostRecent(activePeers)
    if (!winner) return null

    // Self-heal the invalid state: deactivate every other active peer. Fire-and-
    // forget — a failed deactivation must not block sync from proceeding.
    activePeers
      .filter((peer) => peer.id !== winner.id)
      .forEach((peer) => {
        DB.updateStatus(peer.id, "inactive").catch((error) => {
          Logger.warn({ msg: `Failed to deactivate a peer status with id: ${peer.id}`, error })
        })
      })

    return getUrl(winner) || null
  }

  /**
   * Base URL of the cloud server, for the `/api/...` routes only it serves —
   * `getActiveUrl` prefers the hub, which has none of them.
   *
   * Inactive cloud peers count: pairing a hub demotes the cloud peer, but an
   * upload is not a sync. `revoked` and `untrusted` never count. HTTPS only,
   * so callers can safely put a credential on the result.
   */
  export const getCloudApiUrl = async (): Promise<string | null> => {
    const clouds = (await DB.getAll()).filter((peer) => peer.peerType === "cloud_server")
    const usable = clouds.filter((peer) => peer.status === "active" || peer.status === "inactive")
    if (usable.length === 0) return null

    const preferred = usable.find((peer) => peer.status === "active") ?? usable[0]
    const url = getUrl(preferred)
    return url?.startsWith("https://") ? url : null
  }

  /**
   * One-time migration: if there's a HIKMA_API value in SecureStore but no
   * cloud peer registered, create the cloud peer from the legacy URL.
   * Safe to call multiple times — no-ops if a cloud peer already exists.
   */
  export const migrateFromLegacyApiUrl = async (): Promise<void> => {
    const clouds = await DB.getActiveByType("cloud_server")
    if (clouds.length > 0) return

    const SecureStore = require("expo-secure-store")
    const legacyUrl = await SecureStore.getItemAsync("HIKMA_API")
    if (!legacyUrl) {
      const devUrl = process.env.EXPO_PUBLIC_HIKMA_API_TESTING
      if (__DEV__ && devUrl) {
        await DB.upsertCloud(devUrl)
      }
      return
    }

    await DB.upsertCloud(legacyUrl)
  }

  /**
   * True when the device has no sync server registered in any form.
   *
   * Counts inactive and revoked rows, and anything `migrateFromLegacyApiUrl`
   * would turn into a row — that migration runs concurrently with callers, so a
   * device mid-migration must not read as unconfigured.
   */
  export const hasNoConfiguredServer = async (): Promise<boolean> => {
    const peers = await DB.getAll()
    if (peers.length > 0) return false

    const legacyUrl = await SecureStore.getItemAsync("HIKMA_API")
    if (legacyUrl) return false

    return !(__DEV__ && process.env.EXPO_PUBLIC_HIKMA_API_TESTING)
  }

  export const isCloudReachable = async (
    timeoutMs = 5000,
  ): Promise<{ reachable: boolean; url: string | null }> => {
    const clouds = await DB.getActiveByType("cloud_server")
    if (clouds.length === 0) return { reachable: false, url: null }

    const url = clouds[0].metadata?.url as string | undefined
    if (!url) return { reachable: false, url: null }

    const reachable = await checkUrl(url, timeoutMs)
    return { reachable, url }
  }

  /** Race all active cloud server URLs and resolve as soon as any one is reachable. */
  export const isAnyCloudReachable = async (
    timeoutMs = 5000,
  ): Promise<{ reachable: boolean; url: string | null }> => {
    const clouds = await DB.getActiveByType("cloud_server")
    const urls = clouds
      .map((c) => c.metadata?.url as string | undefined)
      .filter((u): u is string => !!u)

    if (urls.length === 0) return { reachable: false, url: null }

    // Race all URLs — first one that succeeds wins
    const result = await Promise.any(
      urls.map(async (url) => {
        const ok = await checkUrl(url, timeoutMs)
        if (!ok) throw new Error("unreachable")
        return url
      }),
    ).catch(() => null)

    return result ? { reachable: true, url: result } : { reachable: false, url: null }
  }

  /**
   * Calls the heartbeat api route
   * @param {string} peerUrl
   * @returns {Promise<boolean>}
   */
  export const heartbeat = async (peerUrl: string): Promise<boolean> => {
    try {
      const response = await fetch(`${peerUrl}/rpc/heartbeat`, { method: "GET" })
      return response.ok
    } catch {
      return false
    }
  }

  export namespace Hub {
    let rehandshaking: Promise<HubSession | null> | null = null

    export const pair = async (hubUrl: string): Promise<RpcResult<HubSession>> => {
      const clientId = await Session.getOrCreateClientId()
      const result = await performHandshake(hubUrl, clientId)
      if (!result.ok) return result

      const session = result.data
      await Session.save(session)

      const hubName =
        session.hubName && session.hubName.length > 0 ? session.hubName : `Hub ${session.hubId}`
      await DB.upsertHub({
        hubId: session.hubId,
        name: hubName,
        publicKey: encode(session.sharedKey),
        url: hubUrl,
      })
      return result
    }

    export const resume = async (): Promise<HubSession | null> => Session.load()

    export const getTransport = async (): Promise<RpcTransport | null> => {
      const session = await Session.load()
      if (!session) return null

      // Always re-handshake to ensure the hub has a valid session.
      // Hub sessions are in-memory and lost on restart; heartbeat only
      // proves the server is up, not that our session exists.
      // Re-handshake is lightweight (one HTTP round-trip).
      if (rehandshaking) {
        const refreshed = await rehandshaking
        return refreshed ? createEncryptedTransport(refreshed) : null
      }

      rehandshaking = (async () => {
        try {
          const clientId = await Session.getOrCreateClientId()
          const result = await performHandshake(session.hubUrl, clientId)
          if (!result.ok) return null
          const newSession: HubSession = { ...result.data, token: session.token }
          await Session.save(newSession)
          return newSession
        } finally {
          rehandshaking = null
        }
      })()

      const refreshed = await rehandshaking
      return refreshed ? createEncryptedTransport(refreshed) : null
    }

    /**
     * Re-authenticate against the hub and persist the new token. Callers reach
     * for this on `AUTH_FAILED`; nothing else renews a hub token.
     *
     * Writes both copies: `HubSession.token` is what sync sends,
     * `provider_token` is what the rest of the app reads.
     *
     * Returns false without touching the existing token, so an unreachable hub
     * does not cost the user their session.
     */
    export const refreshToken = async (): Promise<boolean> => {
      const [email, password] = await Promise.all([
        SecureStore.getItemAsync("provider_email"),
        SecureStore.getItemAsync("provider_password"),
      ])
      if (!email || !password) return false

      const session = await Session.load()
      if (!session) return false

      const transport = createEncryptedTransport(session)
      const result = await transport.login(email, password).catch((error: unknown) => {
        Logger.warn({ msg: "[Hub] token refresh failed", error })
        return null
      })
      if (!result?.ok || !result.data?.token) return false

      await Session.save({ ...session, token: result.data.token })
      await SecureStore.setItemAsync("provider_token", result.data.token)
      return true
    }

    export const unpair = async (): Promise<void> => {
      const session = await Session.load()
      if (session) await DB.revoke(session.hubId)
      await Session.clear()
    }

    export const isPaired = async (): Promise<boolean> => {
      const session = await Session.load()
      return session !== null
    }
  }
}

export default Peer
