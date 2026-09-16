import { SyncDatabaseChangeSet } from "@nozbe/watermelondb/sync"

export async function pushToServer(
  client: {
    baseUrl: string

    email: string

    password: string
  },
  changes: SyncDatabaseChangeSet,
  lastPulledAt?: Date,
) {
  const server = `${client.baseUrl}/api/v2/sync`
  const q = new URLSearchParams()

  if (lastPulledAt) {
    // NOTE: this isn't being used
    q.set("last_pulled_at", lastPulledAt.getTime().toString())
  }

  const res = await fetch(server + `?${q.toString()}`, {
    method: "POST",
    body: JSON.stringify(changes),
    headers: {
      Authorization: `Basic ${btoa(`${client.email}:${client.password}`)}`,
    },
  })

  if (!res.ok) {
    throw new Error(`HTTPError[${res.status}]: failed to push changes to server`)
  }
}
