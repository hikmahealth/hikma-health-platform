import { Logger } from "@hikmahealth/js-utils"

/** Any response carrying an HTTP status — FileSystem upload and download both do. */
type StatusResult = { status: number }

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Run an authorized request, recovering from an expired session once.
 *
 * Retries on a 401 and on a transport error — the upload route authenticates
 * before reading the body, so a dead token can surface as a reset connection
 * rather than a 401.
 *
 * Two attempts at most: a retry re-sends the whole file, and is only safe
 * because the caller holds the resource id fixed so the server sees a replay.
 */
export const requestWithSessionRetry = async <T extends StatusResult>({
  authorization,
  attempt,
  refresh,
}: {
  authorization: string
  attempt: (authorization: string) => Promise<T>
  refresh: () => Promise<string | null>
}): Promise<T> => {
  const first: Outcome<T> = await attempt(authorization).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )

  if (first.ok && first.value.status !== 401) return first.value

  if (!first.ok) {
    Logger.warn({ msg: "Authorized request failed, retrying once", error: first.error })
  }

  const refreshed = await refresh().catch((error: unknown) => {
    Logger.warn({ msg: "Session refresh threw", error })
    return null
  })

  // A 401 we cannot re-credential is final.
  if (first.ok && !refreshed) return first.value

  try {
    return await attempt(refreshed ?? authorization)
  } catch (error: unknown) {
    // Surface the first error: a retry over a dying connection fails less
    // recognisably than the failure the user actually hit.
    throw first.ok ? error : first.error
  }
}
