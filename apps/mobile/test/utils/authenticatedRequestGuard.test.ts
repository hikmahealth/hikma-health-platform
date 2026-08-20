/**
 * Structural guard over the authenticated REST surface.
 *
 * Form-file upload and attachment download independently shipped the same two
 * defects: neither recovered from a 401 (the token expires two hours into a
 * shift), and both resolved the host with `Peer.getActiveUrl`, which prefers
 * the hub and its missing `/api/...` routes. A new call site satisfies these
 * rules via `requestWithSessionRetry` and `Peer.getCloudApiUrl` — see
 * `EventFormScreen.uploadFormFile` for the shape.
 *
 * No exemption list on purpose; add one here with its reason if it is ever
 * needed. Scope: call sites are found by their use of `getProviderAuthHeader`,
 * so a request authenticating another way is invisible here.
 */

import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

const APP_DIR = join(__dirname, "..", "..", "app")

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })

/**
 * Drop comments so the rules below match real code, not prose about it.
 *
 * Line comments must be stripped first: a `//` comment may contain a block
 * opener (a route pattern like "/rpc" then a star), and stripping blocks first
 * pairs it with the next real close marker and deletes the code in between.
 * That silently blinded this guard once — a guard reading "" passes everything.
 *
 * `://` is spared so a url in a string literal does not swallow its own line.
 */
const stripComments = (source: string): string =>
  source.replace(/(^|[^:])\/\/[^\n]*/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, " ")

/** Every file that puts a provider credential on an outbound request. */
const authenticatedCallSites = (): Array<{ path: string; source: string }> =>
  sourceFiles(APP_DIR)
    .map((path) => ({ path, source: stripComments(readFileSync(path, "utf8")) }))
    // The helper's own definition is not a call site.
    .filter(({ path }) => !path.endsWith(join("utils", "authHeader.ts")))
    .filter(({ source }) => source.includes("getProviderAuthHeader("))

const relative = (path: string): string => path.slice(path.indexOf(join("app", "")))

// The guard is only as good as its reader. Each case below is a way the
// stripper can delete real code and turn every rule into a silent pass.
describe("stripComments", () => {
  it("removes a line comment", () => {
    expect(stripComments("const a = 1 // note\nconst b = 2")).not.toContain("note")
  })

  it("removes a block comment", () => {
    expect(stripComments("/** note */\nconst a = 1")).not.toContain("note")
  })

  // The regression: a line comment mentioning a wildcard route opens a block
  // comment that only closes pages later, taking the code with it.
  it("keeps code after a line comment containing a block-comment opener", () => {
    const source = ["// serves /rpc/* only", "const apiUrl = getCloudApiUrl()", "/** doc */"].join(
      "\n",
    )

    expect(stripComments(source)).toContain("getCloudApiUrl()")
  })

  it("keeps a url in a string literal from swallowing its own line", () => {
    const source = 'const url = "https://api.test"\nconst call = getActiveUrl()'

    expect(stripComments(source)).toContain("getActiveUrl()")
  })

  it("keeps code between two block comments", () => {
    const source = "/** one */\nconst apiUrl = getActiveUrl()\n/** two */"

    expect(stripComments(source)).toContain("getActiveUrl()")
  })

  // Every call site this guard reads is a real file; if the stripper mangles
  // them the rules pass vacuously.
  it("leaves the real call sites readable", () => {
    for (const { source } of authenticatedCallSites()) {
      expect(source).toContain("getProviderAuthHeader(")
      expect(source).toContain("Peer.")
    }
  })
})

describe("authenticated REST call sites", () => {
  // Guards the guard: if `getProviderAuthHeader` is renamed or the last caller
  // is removed, the rules below would pass vacuously and protect nothing.
  it("are discoverable, so the rules below are not vacuous", () => {
    expect(authenticatedCallSites().length).toBeGreaterThan(0)
  })

  it.each(authenticatedCallSites().map(({ path, source }) => [relative(path), source]))(
    "%s recovers from an expired session",
    (_path, source) => {
      expect(source).toContain("requestWithSessionRetry")
    },
  )

  it.each(authenticatedCallSites().map(({ path, source }) => [relative(path), source]))(
    "%s does not resolve its host with getActiveUrl",
    (_path, source) => {
      expect(source).not.toContain("getActiveUrl")
    },
  )
})
