import { Database } from "@nozbe/watermelondb"
import LokiJSAdapter from "@nozbe/watermelondb/adapters/lokijs"
import SQLiteAdapter from "@nozbe/watermelondb/adapters/sqlite"
import { setGenerator } from "@nozbe/watermelondb/utils/common/randomId"
import * as Sentry from "@sentry/react-native"
import { uuidv7 } from "uuidv7"

import migrations from "./migrations"
import { modelClasses } from "./modelClasses"
import { type RawSqlAdapter, repairSchemaDrift } from "./repairSchemaDrift"
import schema from "./schema"
import { Logger } from "@hikmahealth/js-utils"

const isTest = process.env.NODE_ENV === "test"

setGenerator(() => uuidv7())

function createAdapter() {
  if (!isTest) {
    return new SQLiteAdapter({
      dbName: "hikmahealthdb",
      schema,
      migrations,
      jsi: true,
      onSetUpError: (error) => {
        Logger.error({ msg: "Database failed to load!", error })
      },
    })
  } else {
    return new LokiJSAdapter({
      schema,
      migrations,
      useWebWorker: false,
      useIncrementalIndexedDB: true,
      dbName: "test_hikmahealthdb",

      onQuotaExceededError: (error) => {
        Sentry.captureException(error)
      },
      onSetUpError: (error) => {
        Sentry.captureException(error)
      },
      extraIncrementalIDBOptions: {
        onDidOverwrite: () => {},
        onversionchange: () => {},
      },
    })
  }
}

export const database = new Database({
  adapter: createAdapter(),
  modelClasses,
})

/**
 * Resolves once this device's tables are known to match `schema.ts`.
 *
 * Every path that writes through sync awaits this, because the columns
 * `repairSchemaDrift` adds are missing from the INSERT target rather than from
 * the payload. Reads need no gate — a missing column only breaks INSERT/UPDATE,
 * and WatermelonDB selects with `table.*`.
 *
 * Chained off `initializingPromise` rather than started alongside it. Adapter
 * methods do not wait for setup, and `setUpWithMigrations` is dispatched from
 * inside `initialize`'s own callback, so a repair kicked off at module load
 * lands *between* the two. `jsi: true` is not protection — WatermelonDB
 * silently downgrades to `'asynchronous'` when the JSI bridge is unavailable.
 *
 * Never rejects, so awaiting it can only delay a caller, never fail one. LokiJS
 * (tests) has no raw SQL and is always built straight from the schema, so there
 * is nothing to repair there.
 */
export const databaseReady: Promise<void> = isTest
  ? Promise.resolve()
  : // `Promise.resolve` rather than reading `.then` off the accessor: if a
    // WatermelonDB upgrade renames or drops `initializingPromise`, this
    // degrades to the old unsequenced behaviour instead of failing to boot.
    Promise.resolve(
      (database.adapter.underlyingAdapter as unknown as { initializingPromise?: Promise<void> })
        .initializingPromise,
    ).then(
      () => repairSchemaDrift(database.adapter as unknown as RawSqlAdapter),
      // Setup failed, so there is no database to repair and `onSetUpError`
      // already owns reporting it. Gated callers should fail on their own terms
      // against a dead database rather than hang waiting on this.
      () => undefined,
    )

export default database
