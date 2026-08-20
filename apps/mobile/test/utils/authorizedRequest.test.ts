/**
 * The session-retry policy behind form-file uploads and attachment downloads.
 *
 * The app holds a two-hour token while a tablet stays signed in all shift, so
 * these requests eventually carry a dead credential. Recovery has to happen
 * exactly once — never zero times, never repeatedly, since each attempt
 * re-sends the whole file over a clinic connection.
 */

jest.mock("@hikmahealth/js-utils", () => ({
  Logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

import { requestWithSessionRetry } from "@/utils/authorizedRequest"

/** An attempt that replays a fixed script of outcomes, one per call. */
const scripted = (...outcomes: Array<{ status: number } | Error>) => {
  const seen: string[] = []
  const attempt = jest.fn(async (authorization: string) => {
    seen.push(authorization)
    const outcome = outcomes[seen.length - 1]
    if (outcome === undefined) throw new Error("attempted more times than scripted")
    if (outcome instanceof Error) throw outcome
    return outcome
  })
  return { attempt, seen }
}

const refreshTo = (header: string | null) => jest.fn(async () => header)

describe("requestWithSessionRetry", () => {
  it("returns a successful response without refreshing the session", async () => {
    const { attempt } = scripted({ status: 200 })
    const refresh = refreshTo("Bearer fresh")

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status: 200 })

    expect(refresh).not.toHaveBeenCalled()
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  // The reported bug, end to end: a provider who signed in three hours ago
  // taps "Choose File" and must not be told to sign in again.
  it("refreshes and retries once on a 401, carrying the new credential", async () => {
    const { attempt, seen } = scripted({ status: 401 }, { status: 200 })
    const refresh = refreshTo("Bearer fresh")

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status: 200 })

    expect(seen).toEqual(["Bearer stale", "Bearer fresh"])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  // Password changed, account disabled, server down. Re-sending the identical
  // dead token would re-upload the file to earn the same refusal.
  it("surfaces the 401 without a second attempt when the refresh fails", async () => {
    const { attempt } = scripted({ status: 401 })
    const refresh = refreshTo(null)

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status: 401 })

    expect(attempt).toHaveBeenCalledTimes(1)
  })

  // "Connection reset": the upload route authenticates before draining the
  // body, so a dead token closes the socket before the client sees the 401.
  it("refreshes and retries once when the transport throws", async () => {
    const { attempt, seen } = scripted(new Error("Connection reset"), { status: 200 })
    const refresh = refreshTo("Bearer fresh")

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status: 200 })

    expect(seen).toEqual(["Bearer stale", "Bearer fresh"])
  })

  it("retries with the original credential when a transport failure cannot be refreshed", async () => {
    const { attempt, seen } = scripted(new Error("Connection reset"), { status: 200 })
    const refresh = refreshTo(null)

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status: 200 })

    expect(seen).toEqual(["Bearer stale", "Bearer stale"])
  })

  // The user hit "Connection reset". Reporting whatever the retry tripped over
  // on a dying connection instead would send support chasing the wrong thing.
  it("reports the first failure, not the retry's, when both attempts throw", async () => {
    const first = new Error("Connection reset")
    const { attempt } = scripted(first, new Error("Software caused connection abort"))

    await expect(
      requestWithSessionRetry({
        authorization: "Bearer stale",
        attempt,
        refresh: refreshTo("Bearer fresh"),
      }),
    ).rejects.toBe(first)

    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it("never attempts more than twice", async () => {
    const { attempt } = scripted({ status: 401 }, { status: 401 })

    await expect(
      requestWithSessionRetry({
        authorization: "Bearer stale",
        attempt,
        refresh: refreshTo("Bearer fresh"),
      }),
    ).resolves.toEqual({ status: 401 })

    expect(attempt).toHaveBeenCalledTimes(2)
  })

  // A refresh that throws is still just a failed refresh; it must not replace
  // the upload error the caller is about to report.
  it("treats a throwing refresh as a failed one", async () => {
    const { attempt } = scripted({ status: 401 })
    const refresh = jest.fn(async () => {
      throw new Error("network down")
    })

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status: 401 })

    expect(attempt).toHaveBeenCalledTimes(1)
  })

  // 403/413/415 are verdicts about the request, not the credential. Retrying
  // spends a second upload to be told the same thing.
  it.each([403, 409, 413, 415, 429, 500])("does not retry a %i", async (status) => {
    const { attempt } = scripted({ status })
    const refresh = refreshTo("Bearer fresh")

    await expect(
      requestWithSessionRetry({ authorization: "Bearer stale", attempt, refresh }),
    ).resolves.toEqual({ status })

    expect(attempt).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })
})
