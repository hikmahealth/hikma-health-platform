import { Logger } from "@hikmahealth/js-utils"
import { createStore } from "@xstate/store"
import { z } from "zod"

const schemaHubSession = z.object({
  hubUrl: z.string(),
  hubId: z.string(),
  hubName: z.string(),
  clientId: z.string(),
  sharedKey: z.any(),
  token: z.string().nullable(),
})

const basePeerSchema = z.object({
  status: z.enum(["linked"]),
  last_synced_at: z.date().nullish(),
  last_pinged_at: z.date().nullish(),
})

const peerTypeSchema = z.discriminatedUnion("type", [
  basePeerSchema.safeExtend({
    type: z.literal("sync_hub"),
    hub_session: schemaHubSession,
  }),
  basePeerSchema.safeExtend({
    type: z.literal("cloud_server"),
    url: z.url(),
  }),
])

const peerSchema = z.discriminatedUnion("status", [
  peerTypeSchema,
  z.object({ status: z.enum(["offline", "connecting"]) }),
  z.object({
    status: z.literal("error"),
    error: z.unknown().nullable().default(null),
  }),
])

/**
 * State to manage the connections that's made to the phone at any on time
 */
const PeerState = createStore({
  schemas: {
    context: peerSchema,
  },
  context: {
    status: "offline",
  },
  on: {
    setHub(_context, data: z.input<typeof schemaHubSession>) {
      if (_context.status !== "offline" && _context.status !== "error") {
        Logger.warn("cannot connect to something that's already connecting/linked")
        console.warn("SETTING: ", _context)
        return
      }

      return {
        status: "linked",
        type: "sync_hub",
        hub_session: schemaHubSession.parse(data),
      }
    },

    setCloudUrl(_context, data: { url: string }) {
      if (_context.status !== "offline" && _context.status !== "error") {
        Logger.warn("cannot connect to something that's already connecting/linked")
        console.warn("SETTING: ", _context)
        return
      }

      console.log("cloudUrl to set", data.url)
      console.log(typeof data.url)

      return {
        status: "linked",
        type: "cloud_server",
        url: data.url,
      }
    },

    errored(_, err) {
      return { status: "error", error: err }
    },

    disconnect(_context) {
      if (_context.status === "offline") {
        Logger.warn("already disconnected")
        return
      }

      return {
        status: "offline",
      }
    },
  },
})

export default PeerState
