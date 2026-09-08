import { assign, createActor, createMachine, emit, fromPromise, setup } from "xstate"
import { z } from "zod"

import { UserStore } from "../store-user"
import PeerState from "../peers/state"
import { createStore } from "@xstate/store"

/**
 * The phases of the sync operation. Used to annotate the emitted
 * `requested` / `applied` events so subscribers know which side of the
 * sync the event belongs to.
 */
export const syncPhaseSchema = z.enum(["fetch", "push", "pull"])
export type SyncPhase = z.infer<typeof syncPhaseSchema>

/**
 * Context carried by the sync machine across every state.
 */
export const syncContextSchema = z.object({
  max_retries: z.number().int().nonnegative().default(3),
  retries: z.number().int().nonnegative().default(0),
  error: z.unknown().nullable().default(null),
})
export type SyncContext = z.infer<typeof syncContextSchema>

/**
 * Events that can be *sent* to the machine to drive it between states. These
 * are dispatched by the orchestration that runs the actors (see
 * `./operation`), never produced by the machine itself.
 */
export const syncEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("push") }),
  z.object({ type: z.literal("pull") }),
  z.object({ type: z.literal("applied") }),
  z.object({ type: z.literal("complete") }),
  z.object({ type: z.literal("error"), error: z.unknown().nullable() }),
])
export type SyncEvent = z.infer<typeof syncEventSchema>

/**
 * Events the machine *emits* to the outside world as it transitions.
 * Subscribers (UI, telemetry, etc.) can listen for these.
 */
export const syncEmittedSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started") }),
  z.object({ type: z.literal("requested"), phase: syncPhaseSchema }),
  z.object({ type: z.literal("applied"), phase: syncPhaseSchema }),
  z.object({ type: z.literal("errored"), error: z.unknown().nullable() }),
  z.object({ type: z.literal("completed") }),
])
export type SyncEmitted = z.infer<typeof syncEmittedSchema>

// ===========================================================================
// State machine
//
// The machine describes *only* the states, the transitions between them, and
// the lifecycle events it emits. It performs no side-effects and invokes no
// actors: it is driven purely by the events sent to it.
//
//   idle → starting → (pushing → pulling) | pulling → idle
//
// - `idle`     : nothing running; the only way out is `start` → `starting`.
// - `starting` : first transition; waits for the fetch to resolve, then is told
//                to `push` or `pull`.
// - `pushing`  : local data is being pushed; the only state that can follow is
//                `pulling`.
// - `pulling`  : peer data is being applied locally; then back to `idle`.
// ===========================================================================
export const syncMachine = setup({
  types: {
    context: {} as SyncContext,
    events: {} as SyncEvent,
    emitted: {} as SyncEmitted,
  },
  actors: {
    fetchData: fromPromise(async ({ input }) => {
      // fetch the data from statbase
    }),
  },
  actions: {
    resetError: assign({ error: null, retries: 0 }),
    recordError: assign({
      error: ({ event }) => ("error" in event ? event.error : null),
    }),
    emitStarted: emit({ type: "started" }),
    emitCompleted: emit({ type: "completed" }),
    emitErrored: emit(({ event }) => ({
      type: "errored" as const,
      error: "error" in event ? event.error : null,
    })),
  },
}).createMachine({
  id: "sync",
  initial: "idle",
  context: syncContextSchema.parse({}),
  states: {
    /**
     * Sync is not happening and can be invoked. Only `starting` can follow.
     */
    idle: {
      on: {
        start: { target: "starting", actions: "resetError" },
      },
    },

    /**
     * First transition. The fetch to the server happens outside the machine;
     * once it resolves the orchestrator sends `push` or `pull`.
     */
    starting: {
      entry: ["emitStarted", emit({ type: "requested", phase: "fetch" })],
      invoke: {
        src: "fetchData",
        input: readSyncInput,
      },
      on: {
        push: "pushing",
        pull: "pulling",
        error: { target: "idle", actions: ["recordError", "emitErrored"] },
      },
    },

    /**
     * Local data is pushed to the provider server. Only `pulling` can follow.
     */
    pushing: {
      entry: emit({ type: "requested", phase: "push" }),
      on: {
        applied: { actions: emit({ type: "applied", phase: "push" }) },
        pull: "pulling",
        error: { target: "idle", actions: ["recordError", "emitErrored"] },
      },
    },

    /**
     * Peer data is applied to the device database, then sync completes.
     */
    pulling: {
      entry: emit({ type: "requested", phase: "pull" }),
      on: {
        applied: { actions: emit({ type: "applied", phase: "pull" }) },
        complete: { target: "idle", actions: "emitCompleted" },
        error: { target: "idle", actions: ["recordError", "emitErrored"] },
      },
    },
  },
})

/**
 * A running instance of the sync machine. Send events with `SyncState.send(...)`
 * and listen for lifecycle events with `SyncState.on("started", ...)` etc.
 */
export const SyncState = createActor(syncMachine)

// ===========================================================================
// Cross-store dependencies
//
// The actors depend on values owned by other stores: the authenticated
// provider (`UserStore`) and the linked peer connection (`PeerState`).
// ===========================================================================

/**
 * The connection + identity details every sync actor depends on, resolved and
 * validated from the user and peer stores. This is the "ready to sync" shape.
 */
export const syncSessionSchema = z.object({
  provider: z.object({
    id: z.string(),
    clinic_id: z.string().nullable(),
  }),
  peer: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("sync_hub"),
      url: z.string(),
      token: z.string().nullable(),
    }),
    z.object({
      type: z.literal("cloud_server"),
      url: z.url(),
    }),
  ]),
})
export type SyncSession = z.infer<typeof syncSessionSchema>

/**
 * Narrow + validate the raw store snapshots into a usable {@link SyncSession}.
 * Throws when there is no authenticated provider or no linked peer.
 */
export function readSyncInput(): SyncSession {
  const provider = UserStore.getSnapshot().context.data,
    peer = PeerState.getSnapshot().context

  if (!provider) {
    throw new Error("[sync] no authenticated provider in UserStore")
  }

  if (peer.status !== "linked") {
    throw new Error(`[sync] peer is not linked (status: ${peer.status})`)
  }

  const connection =
    peer.type === "sync_hub"
      ? {
          type: "sync_hub" as const,
          url: peer.hub_session.hubUrl,
          token: peer.hub_session.token,
        }
      : {
          type: "cloud_server" as const,
          url: peer.url,
        }

  return syncSessionSchema.parse({
    provider: { id: provider.id, clinic_id: provider.clinic_id },
    peer: connection,
  })
}

// ===========================================================================
// Actors (side-effects)
//
// These live *outside* the machine. Each is a standalone actor that performs
// one async unit of work in the sync pipeline and receives the resolved store
// dependencies as `input`. The orchestration in `./operation` runs them and
// sends the corresponding events to the machine.
//
// They are intentionally left unimplemented (placeholders).
// ===========================================================================

// /**
//  * `starting`: reach out to the server for the info needed to decide how to sync
//  * (e.g. cursors, last-synced markers, direction).
//  *
//  * TODO: implement the server fetch.
//  */
// export const fetchServerInfo = fromPromise<{ direction: "push" | "pull" }, SyncDeps>(
//   async ({ input }) => {
//     const session = resolveSyncSession(input)
//     // TODO: hit `session.peer.url` using `session.provider` (+ token, if any).
//     void session
//     return { direction: "push" }
//   },
// )

/**
 * `pushing`: read the pending local data out of the device database.
 *
 * TODO: implement the database read.
 */
export const collectLocalChanges = fromPromise<unknown[], SyncSession>(async ({ input }) => {
  // TODO: pull data from the device database (e.g. scoped to session.provider.clinic_id).
  return []
})

/**
 * `pushing`: send the collected local data to the provider server.
 *
 * TODO: implement the upload.
 */
export const pushToServer = fromPromise<void, SyncSession>(async ({ input }) => {
  // TODO: send local data to `session.peer.url`.
})

/**
 * `pulling`: request data from the peer/provider server.
 *
 * TODO: implement the download.
 */
export const pullFromPeerServer = fromPromise<unknown[], SyncSession>(async ({ input }) => {
  // TODO: pull data from `session.peer.url`.
  return []
})

/**
 * `pulling`: apply the pulled data to the device database.
 *
 * TODO: implement the database write.
 */
export const applyToDatabase = fromPromise<void, SyncSession>(async ({ input }) => {
  // TODO: sync the pulled data with the device database.
})
