/**
 * Structural guard over the host `User.signIn` authenticates against.
 *
 * `signIn` used to resolve its own host with `Peer.getActiveUrl()`, which
 * answers "which peer is the sync target?" and prefers a hub — and hubs serve
 * no `/api/login`. Worse, `getActiveUrl` deactivates every peer it did not
 * pick, so `AppNavigator`'s re-auth demoted the cloud peer it had just proved
 * reachable, and the defect read as intermittent session expiry.
 *
 * The fix is a required `apiUrl` parameter. These rules read source text: they
 * prove `User.ts` cannot reach for a peer lookup and that no call site dropped
 * back to two arguments, not that the URL passed belongs to a cloud peer.
 */

import { readFileSync } from "fs"
import { join } from "path"

const APP_DIR = join(__dirname, "..", "..", "app")

const read = (relative: string): string => readFileSync(join(APP_DIR, relative), "utf8")

/**
 * Drop comments so the rules match real code, not prose about it.
 *
 * Line comments must be stripped first: a `//` comment may contain a block
 * opener (a route pattern like "/rpc" then a star), and stripping blocks first
 * pairs it with the next real close marker, deleting the code in between. That
 * mistake blinded `test/utils/authenticatedRequestGuard.test.ts` once.
 *
 * `://` is spared so a url in a string literal does not swallow its own line.
 */
const stripComments = (source: string): string =>
  source.replace(/(^|[^:])\/\/[^\n]*/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, " ")

/** The four places that authenticate a provider against a cloud server. */
const CALL_SITES = [
  "navigators/AppNavigator.tsx",
  "screens/LoginScreen.tsx",
  "db/peerSync.ts",
  "services/syncService.ts",
] as const

describe("User.signIn host resolution", () => {
  describe("the callee cannot pick its own host", () => {
    it("declares apiUrl as a parameter", () => {
      const source = stripComments(read("models/User.ts"))
      expect(source).toMatch(
        /export const signIn = async \(\s*email: string,\s*password: string,\s*apiUrl: string,?\s*\)/,
      )
    })

    it("builds the login endpoint from that parameter", () => {
      const source = stripComments(read("models/User.ts"))
      expect(source).toContain("`${apiUrl}/api/login`")
    })

    it("does not import Peer at all", () => {
      // The strongest form of the guarantee: with no Peer in scope, no future
      // edit inside this file can reintroduce a peer lookup by accident.
      const source = stripComments(read("models/User.ts"))
      expect(source).not.toMatch(/^import .*from "@\/models\/Peer"/m)
    })

    it("never mentions getActiveUrl in code", () => {
      const source = stripComments(read("models/User.ts"))
      expect(source).not.toContain("getActiveUrl")
    })
  })

  describe("every caller passes a host", () => {
    it.each(CALL_SITES)("%s calls signIn with three arguments", (relative) => {
      const source = stripComments(read(relative))
      const calls = source.match(/User\.signIn\([^)]*\)/g) ?? []
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) {
        // Two arguments means the host is being resolved somewhere else again.
        expect(call.split(",").length).toBeGreaterThanOrEqual(3)
      }
    })

    it("has no call sites outside the four listed here", () => {
      // A fifth caller is not forbidden, but it must be added to CALL_SITES so
      // the rules above cover it. Failing here is the prompt to do that.
      const { readdirSync, statSync } = require("fs")
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((entry: string) => {
          const full = join(dir, entry)
          if (statSync(full).isDirectory()) return walk(full)
          return /\.tsx?$/.test(entry) ? [full] : []
        })

      const found = walk(APP_DIR)
        .filter((path) => stripComments(readFileSync(path, "utf8")).includes("User.signIn("))
        .map((path) =>
          path
            .slice(APP_DIR.length + 1)
            .split("\\")
            .join("/"),
        )

      expect(found.sort()).toEqual([...CALL_SITES].sort())
    })
  })

  describe("the sync REST host is chosen the same way", () => {
    it("peerSync derives the sync url from the peer being synced", () => {
      const source = stripComments(read("db/peerSync.ts"))
      expect(source).toContain("const getCloudBaseUrl = (peer: Peer.T): string =>")
      expect(source).not.toContain("getActiveUrl")
    })
  })

  describe("credentials stay out of the log line", () => {
    it("does not log the password alongside the endpoint", () => {
      // Logger.log no-ops in production, so this was never a live leak — but a
      // password in a dev console is still a password on a shared screen.
      const source = stripComments(read("models/User.ts"))
      expect(source).not.toMatch(/Logger\.log\(\{[^}]*\bpassword\b[^}]*\}\)/)
    })
  })
})
