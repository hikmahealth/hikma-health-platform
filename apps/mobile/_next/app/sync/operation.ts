import { createActor, toPromise, type AnyActorLogic, type InputFrom, type OutputFrom } from "xstate"

import {
  SyncState,
  collectLocalChanges,
  pushToServer,
  pullFromPeerServer,
  applyToDatabase,
} from "./store"

/**
 * Run a standalone actor to completion and resolve with its output.
 *
 * The actors live outside the state machine; this is the glue that executes one
 * and waits for its result so the orchestration can react to it.
 */
function runActor<TLogic extends AnyActorLogic>(
  logic: TLogic,
  input: InputFrom<TLogic>,
): Promise<OutputFrom<TLogic>> {
  const actor = createActor(logic, { input })
  const output = toPromise(actor)
  actor.start()
  return output
}

/**
 * Orchestrate the sync process.
 *
 * The machine only tracks state + emits lifecycle events; the actual work (and
 * the decision of which events to send) happens here:
 *
 *   start → fetch → (push →) pull → complete
 *
 * Any failure sends `error` to the machine, which returns it to `idle`.
 */
export const startSync = async function () {
  // Make sure the machine actor is running before we send it anything.
  SyncState.start()

  // Snapshot the stores the actors depend on (provider + peer).
  const deps = readSyncDeps()

  SyncState.send({ type: "start" })

  try {
    // `starting`: figure out which direction to sync.
    const { direction } = await runActor(fetchServerInfo, deps)

    if (direction === "push") {
      // `pushing`: collect local changes and send them up.
      SyncState.send({ type: "push" })
      await runActor(collectLocalChanges, deps)
      await runActor(pushToServer, deps)
      SyncState.send({ type: "applied" })

      // Only `pulling` can follow a push.
      SyncState.send({ type: "pull" })
    } else {
      SyncState.send({ type: "pull" })
    }

    // `pulling`: pull peer data and apply it locally.
    await runActor(pullFromPeerServer, deps)
    await runActor(applyToDatabase, deps)
    SyncState.send({ type: "applied" })

    SyncState.send({ type: "complete" })
  } catch (error) {
    SyncState.send({ type: "error", error })
  }
}

// TODO: current implementation requires that I am able to trigger syncronization
// process, strictly by flipping the switch.
