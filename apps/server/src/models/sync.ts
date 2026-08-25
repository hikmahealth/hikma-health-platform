import db from "@/db";
// import AppConfig from "./app-config";
import { toSafeDateString } from "@/lib/utils";
import User from "./user";
import type Device from "./device";
import UserClinicPermissions from "./user-clinic-permissions";
import type { RequestCaller } from "@/types";
import { Logger } from "@hikmahealth/js-utils";
import {
  ENTITIES_TO_PUSH_TO_MOBILE,
  ENTITIES_TO_PUSH_TO_HUB,
  ENTITIES_TO_PULL_FROM_MOBILE,
  ENTITIES_TO_PULL_FROM_HUB,
  EXEMPT_FROM_HISTORY_LIMIT,
  CLINIC_COLUMN_BY_TABLE,
  FULL_SNAPSHOT_TABLES,
  syncSelection,
  applyClinicScope,
  getMaxHistoryDaysSync,
  normalizeCivilDates,
} from "./sync-shared";

/** Returns true if the value looks like a raw epoch timestamp (10-13 digit numeric string or number, possibly negative for pre-1970 dates). */
export const isEpochTimestamp = (value: unknown): boolean =>
  (typeof value === "string" && /^-?\d{10,13}$/.test(value.trim())) ||
  (typeof value === "number" &&
    ((value > 1e9 && value < 1e14) || (value < -1e9 && value > -1e14)));

/**
 * `pg_catalog.pg_type.typname` values for date/time columns. Kysely's
 * PostgreSQL introspector returns these short names rather than the long
 * `information_schema` spellings (`"timestamp with time zone"`, etc.).
 */
const PG_DATE_TYPE_NAMES: ReadonlySet<string> = new Set([
  "date",
  "timestamp",
  "timestamptz",
  "time",
  "timetz",
]);

let dateColumnsByTable: ReadonlyMap<string, ReadonlySet<string>> | null = null;
let dateColumnsLoadPromise: Promise<void> | null = null;

/**
 * Loads the table → date-column map directly from `pg_catalog`. The schema is
 * migration-controlled and stable for the process lifetime, so the result is
 * cached indefinitely. Concurrent first callers share the in-flight promise;
 * a failed load is not cached, so the next call retries.
 *
 * Restricted to the `public` schema to avoid name collisions if a future
 * migration creates tables in another schema.
 */
export const loadDateColumnsByTable = async (): Promise<void> => {
  if (dateColumnsByTable) return;
  if (dateColumnsLoadPromise) return dateColumnsLoadPromise;
  dateColumnsLoadPromise = (async () => {
    const tables = await db.introspection.getTables();
    const next = new Map<string, ReadonlySet<string>>();
    for (const t of tables) {
      if (t.schema && t.schema !== "public") continue;
      const dateCols = new Set<string>();
      for (const col of t.columns) {
        if (PG_DATE_TYPE_NAMES.has(col.dataType)) dateCols.add(col.name);
      }
      next.set(t.name, dateCols);
    }
    dateColumnsByTable = next;
  })();
  try {
    await dateColumnsLoadPromise;
  } finally {
    dateColumnsLoadPromise = null;
  }
};

/**
 * Returns true iff `(tableName, columnName)` is a date/timestamp column.
 *
 * Schema-driven via `pg_catalog` — the database is the source of truth, not
 * a name suffix heuristic. Gates epoch-ms → ISO and "0" → null coercion in
 * `persistClientChanges`. A wrong answer is dangerous either way:
 *   - false positive on a text column (phone, government_id) silently
 *     overwrites the value with an ISO timestamp,
 *   - false negative on a real date column leaves an epoch-ms payload
 *     untouched and Postgres rejects the insert.
 *
 * Throws if called before `loadDateColumnsByTable()` has resolved — fail
 * loud is safer than silently misclassifying every column as non-date.
 */
export const isDateColumn = (
  tableName: string,
  columnName: string,
): boolean => {
  if (!dateColumnsByTable) {
    throw new Error(
      "[sync] isDateColumn called before loadDateColumnsByTable() resolved",
    );
  }
  return dateColumnsByTable.get(tableName)?.has(columnName) ?? false;
};

/**
 * Did an upsert actually write?
 *
 * Every model upserts one row at a time and guards it with
 * `ON CONFLICT DO UPDATE ... WHERE excluded.updated_at > <table>.updated_at`.
 * When that guard rejects a stale record, Kysely's `.executeTakeFirst()`
 * returns `{ numInsertedOrUpdatedRows: 0n }` — verified against Postgres in
 * tests/integration/models/sync-rejections.test.ts.
 *
 * It is NOT `undefined`, despite the inline comment in `event.ts` saying so.
 * The undefined/null branch below is defensive, for a model that adds RETURNING
 * or a future driver change. Since the conflict target is the primary key and
 * DO UPDATE always writes when its WHERE passes, a zero count is unambiguously
 * a rejection, not a no-op.
 *
 * A row count counts whether it arrives as a bigint or a number. Kysely's own
 * `InsertResult` uses bigint, but `appointment.ts` and `prescription.ts` build
 * their own `{ numInsertedOrUpdatedRows }` and appointment's passes it through
 * `Number()` — so reading only the bigint shape reports a rejected record as
 * ACCEPTED, and the client marks it synced and loses the user's edit on the next
 * pull. The row fallback below stays for models that return `returningAll()`
 * instead of a count.
 */
export const classifyUpsertResult = (result: unknown): boolean => {
  if (result === undefined || result === null) return false;
  const rows = (result as { numInsertedOrUpdatedRows?: unknown })
    .numInsertedOrUpdatedRows;
  if (typeof rows === "bigint") return rows > 0n;
  // NaN is not > 0, so an unparseable count reads as a rejection — the safe
  // direction: the client keeps the record pending rather than discarding it.
  if (typeof rows === "number") return rows > 0;
  return true;
};

/**
 * The SQLSTATE classes that describe ONE record rather than the request: 22xxx
 * data exceptions (numeric overflow, string too long, bad input syntax) and
 * 23xxx integrity violations (foreign key, check, unique). Returns the code, so
 * the caller can log which rule fired.
 *
 * Everything else — a dropped connection, an exhausted pool, an admin shutdown
 * — is about the batch and must keep failing the whole push, or an outage would
 * report as "every record rejected" with a 200.
 */
export const recordLevelErrorCode = (error: unknown): string | null => {
  // pg errors arrive bare from the model layer today; the cause walk covers a
  // model that wraps its failures, bounded so a self-referential cause cannot
  // spin.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^2[23]/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};

namespace Sync {
  const pushTableNameModelMap = ENTITIES_TO_PULL_FROM_MOBILE.reduce(
    (acc, entity) => {
      acc[entity.Table.name] = entity;
      return acc;
    },
    {} as Record<PostTableName, (typeof ENTITIES_TO_PULL_FROM_MOBILE)[number]>,
  );

  const hubPushTableNameModelMap = ENTITIES_TO_PULL_FROM_HUB.reduce(
    (acc, entity) => {
      acc[entity.Table.name] = entity;
      return acc;
    },
    {} as Record<string, (typeof ENTITIES_TO_PULL_FROM_HUB)[number]>,
  );

  export type PostTableName =
    (typeof ENTITIES_TO_PULL_FROM_MOBILE)[number]["Table"]["name"];

  // Core types for WatermelonDB sync
  type SyncableEntity = {
    getDeltaRecords(lastSyncedAt: number): DeltaData;
    applyDeltaChanges(deltaData: DeltaData, lastSyncedAt: number): void;
  };

  export type DeltaData = {
    created: Record<string, any>[];
    updated: Record<string, any>[];
    deleted: string[];
    // toDict(): { created: any[]; updated: any[]; deleted: string[] };
  };

  /**
   * Method to init a new DeltaData instance
   * @param {Record<string, any>[]} created - Array of created records
   * @param {Record<string, any>[]} updated - Array of updated records
   * @param {string[]} deleted - Array of deleted record IDs
   * @returns {DeltaData}
   */
  function createDeltaData(
    created: Record<string, any>[],
    updated: Record<string, any>[],
    deleted: string[],
  ): DeltaData {
    return {
      created,
      updated,
      deleted,
    };
  }

  // Pull endpoint types
  type PullRequest = {
    last_pulled_at: number;
    schemaVersion?: number;
    migration?: any;
  };

  type PullResponse = {
    changes: {
      [tableKey: string]: {
        created: Record<string, any>[];
        updated: Record<string, any>[];
        deleted: string[];
      };
    };
    timestamp: number;
  };

  // Push endpoint types
  export type PushRequest = {
    [tableKey in PostTableName]: {
      created: Record<string, any>[];
      updated: Record<string, any>[];
      deleted: string[];
    };
  };

  type PushResponse = {
    ok: boolean;
    timestamp: string;
  };

  type DBChangeSet = PullResponse["changes"];

  /**
   * Every live row as `updated`, every removed row's id as `deleted`.
   *
   * `updated` rather than `created`: WatermelonDB updates the rows the device
   * already has and creates the ones it does not, whereas `created` logs an
   * error for every row that already exists. The one error it does log per
   * created row is worth keeping — it names devices that were missing a clinic.
   *
   * Both predicates read `is_deleted` null-safely, since it is nullable and
   * `is_deleted = false` does not match NULL — such a row would otherwise be
   * neither live nor deleted and vanish from both lists. The deleted side keys
   * on `is_deleted` OR `deleted_at` so a row flagged without a timestamp is
   * still removed from devices.
   */
  const getFullSnapshot = async (
    tableName: string,
    hubClinicIds: string[] | null,
    peerType: Device.DeviceTypeT,
  ): Promise<DeltaData> => {
    const selection = syncSelection(tableName, peerType);
    const liveRows = db
      .selectFrom(tableName as "clinics")
      .where("deleted_at", "is", null)
      .where("is_deleted", "is not", true);

    const live = await applyClinicScope(
      // Cast for the same reason as the table name above: the projection is
      // resolved at runtime, which the static schema cannot express.
      selection
        ? liveRows.select(selection as unknown as "id")
        : liveRows.selectAll(),
      tableName,
      hubClinicIds,
    ).execute();

    const removed = await applyClinicScope(
      db
        .selectFrom(tableName as "clinics")
        .where((eb) =>
          eb.or([eb("is_deleted", "=", true), eb("deleted_at", "is not", null)]),
        )
        .select("id"),
      tableName,
      hubClinicIds,
    ).execute();

    return createDeltaData(
      [],
      normalizeCivilDates(tableName, live),
      removed.map((record: { id: string }) => record.id),
    );
  };

  /**
   * Get the delta records for the last synced at time
   * TODO: if lastSyncedAt is 0, no deleted records should be returned
   * @param lastSyncedAt
   * @returns
   */
  export const getDeltaRecords = async (
    lastSyncedAt: number,
    peerType: Device.DeviceTypeT,
    caller: RequestCaller,
  ): Promise<DBChangeSet> => {
    /** Determine what gets pushed to the client based on the peer type */
    const ENTITIES_TO_PUSH_TO_CLIENT =
      peerType === "sync_hub"
        ? ENTITIES_TO_PUSH_TO_HUB
        : ENTITIES_TO_PUSH_TO_MOBILE;
    const result: DBChangeSet = {};

    // Hub peers only receive data for their assigned clinics
    const hubClinicIds: string[] | null =
      peerType === "sync_hub" && "device" in caller
        ? ((caller.device.clinic_ids as unknown as string[]) ?? null)
        : null;

    const clientLastSyncDate = new Date(lastSyncedAt);
    const now = new Date();

    // Apply history limit if MAX_HISTORY_DAYS_SYNC is set
    const maxHistoryDays = getMaxHistoryDaysSync();
    let effectiveLastSyncDate = clientLastSyncDate;

    if (maxHistoryDays !== null) {
      const cutoffDate = new Date(
        now.getTime() - maxHistoryDays * 24 * 60 * 60 * 1000,
      );
      // Use the more recent date between client's last sync and the cutoff
      effectiveLastSyncDate =
        clientLastSyncDate < cutoffDate ? cutoffDate : clientLastSyncDate;
    }

    for (const entity of ENTITIES_TO_PUSH_TO_CLIENT) {
      // It can happen that the server table name is different from the mobile table name
      // This just ensures we do the correct mapping. Often the name is the same.
      const server_table_name = entity.Table.name;
      const mobile_table_name = entity.Table.mobileName;
      const always_push_to_mobile =
        entity.Table?.ALWAYS_PUSH_TO_MOBILE || false;

      // Replicated whole, so the watermark never applies to it.
      if (FULL_SNAPSHOT_TABLES.has(server_table_name)) {
        result[mobile_table_name] = await getFullSnapshot(
          server_table_name,
          hubClinicIds,
          peerType,
        );
        continue;
      }

      // Configuration entities should always sync full history, not limited by MAX_HISTORY_DAYS_SYNC
      const isExemptFromHistoryLimit =
        EXEMPT_FROM_HISTORY_LIMIT.includes(mobile_table_name);

      // TODO: Implementation logic for always_push_to_mobile needs to be thought out first.
      // let lastSyncDate = always_push_to_mobile ? now : effectiveLastSyncDate;
      let lastSyncDate = isExemptFromHistoryLimit
        ? clientLastSyncDate
        : effectiveLastSyncDate;

      // Held on the delta path too, so dropping a table out of
      // FULL_SNAPSHOT_TABLES cannot quietly widen what a device receives.
      const selection = syncSelection(server_table_name, peerType);

      // Query for new records created at or after last sync.
      // Using >= to avoid missing records created exactly at the boundary timestamp.
      const createdRows = db
        .selectFrom(server_table_name)
        .where("server_created_at", ">=", lastSyncDate)
        .where("deleted_at", "is", null)
        .where("is_deleted", "=", false);

      const newRecords = await applyClinicScope(
        selection
          ? createdRows.select(selection as unknown as "id")
          : createdRows.selectAll(),
        server_table_name,
        hubClinicIds,
      ).execute();

      // Query for records updated since last sync (but created before)
      const modifiedRows = db
        .selectFrom(server_table_name)
        .where("last_modified", ">", lastSyncDate)
        .where("server_created_at", "<", lastSyncDate)
        .where("deleted_at", "is", null)
        .where("is_deleted", "=", false);

      const updatedRecords = await applyClinicScope(
        selection
          ? modifiedRows.select(selection as unknown as "id")
          : modifiedRows.selectAll(),
        server_table_name,
        hubClinicIds,
      ).execute();

      // Query for records deleted since last sync
      const deletedRecords =
        lastSyncedAt === 0
          ? []
          : await applyClinicScope(
              db
                .selectFrom(server_table_name)
                .where("deleted_at", ">", lastSyncDate)
                .where("is_deleted", "=", true)
                .select("id"),
              server_table_name,
              hubClinicIds,
            ).execute();

      const deltaData = createDeltaData(
        normalizeCivilDates(server_table_name, newRecords),
        normalizeCivilDates(server_table_name, updatedRecords),
        deletedRecords.map((record: { id: string }) => record.id),
      );

      // Add records to result
      result[mobile_table_name] = deltaData;
    }

    // TODO: Pull out these table right up there near SyncableEntity definitions as a down only list of tables.
    // Process the user clinic permissions. They dont use last modified or server created attribute
    result["user_clinic_permissions"] = {
      created: await applyClinicScope(
        db
          .selectFrom("user_clinic_permissions")
          .where("created_at", ">=", clientLastSyncDate)
          .selectAll(),
        "user_clinic_permissions",
        hubClinicIds,
      ).execute(),
      updated: await applyClinicScope(
        db
          .selectFrom("user_clinic_permissions")
          .where("created_at", "<", clientLastSyncDate)
          .where("updated_at", ">", clientLastSyncDate)
          .selectAll(),
        "user_clinic_permissions",
        hubClinicIds,
      ).execute(),
      deleted: [], // THERE are no deleted records. Any record that is gone, is just gone.
    };

    // Process the app config. They dont use last modified or server created attribute
    result["app_config"] = {
      created: await db
        .selectFrom("app_config")
        .where("created_at", ">=", clientLastSyncDate)
        .selectAll()
        .execute(),
      updated: await db
        .selectFrom("app_config")
        .where("created_at", "<", clientLastSyncDate)
        .where("updated_at", ">", clientLastSyncDate)
        .selectAll()
        .execute(),
      deleted: [], // THERE are no deleted records. Any record that is gone, is just gone.
    };

    return result;
  };

  /**
   * Checks whether a record is authorized for a hub to push, based on
   * the record's clinic association and the hub's authorized clinic IDs.
   * Returns true if the table has no direct clinic column (indirectly associated).
   */
  function isRecordAuthorizedForClinic(
    record: Record<string, any>,
    tableName: string,
    authorizedClinicIds: Set<string>,
  ): boolean {
    const clinicColumn = CLINIC_COLUMN_BY_TABLE[tableName];
    if (!clinicColumn) return true;

    const recordClinicId = record[clinicColumn];
    // Null/undefined clinic — allow (e.g. patients with no primary_clinic_id yet)
    if (!recordClinicId) return true;

    return authorizedClinicIds.has(recordClinicId);
  }

  /**
   * Persist the delta data from the client.
   *
   * **Clock-skew assumption**: Each model's upsert uses a WHERE guard
   * (`excluded.updated_at > <table>.updated_at`) to reject stale records.
   * `excluded.updated_at` is the *client-provided* timestamp from the INSERT
   * VALUES clause, while the stored value may be either client-provided or
   * server-set (`now()`) depending on the model. This means a client whose
   * clock is significantly behind the server could have legitimate updates
   * silently dropped. Callers (mobile apps / hubs) should keep their clocks
   * reasonably synchronised (e.g. via NTP).
   *
   * @param entity
   * @param deltaData
   */
  export type PushOutcome = {
    accepted: number;
    rejected: Record<string, string[]>;
    byTable: Record<string, { accepted: number; rejected: number }>;
  };

  /**
   * Entities whose upsert return value has been verified to distinguish an
   * applied write from a guard rejection.
   *
   * Restricted to what mobile pushes. The hub-only additions each return
   * something `classifyUpsertResult` would read wrongly: `device_pin_codes` is
   * a deliberate no-op returning undefined (reported as rejected, so a client
   * would keep the record pending forever), and `drug_catalogue` returns an
   * un-run Effect — an object with no row count, reported as accepted for a
   * write that never happened. Both are out of scope here; excluding them keeps
   * PushOutcome honest about what it can speak to.
   */
  const REPORTABLE_TABLES: ReadonlySet<string> = new Set(
    ENTITIES_TO_PULL_FROM_MOBILE.map((e) => e.Table.name),
  );

  export const persistClientChanges = async (
    data: PushRequest,
    peerType: Device.DeviceTypeT,
    caller: RequestCaller,
  ): Promise<PushOutcome> => {
    // Hub peers can push a wider set of entities than mobile devices
    const isHub = peerType === "sync_hub";
    const entitiesToPull = isHub
      ? ENTITIES_TO_PULL_FROM_HUB
      : ENTITIES_TO_PULL_FROM_MOBILE;
    const tableModelMap: Record<
      string,
      (typeof ENTITIES_TO_PULL_FROM_HUB)[number]
    > = isHub ? hubPushTableNameModelMap : pushTableNameModelMap;

    // Hub authorization: build a set of allowed clinic IDs for fast lookups
    const hubAuthorizedClinicIds: Set<string> | null =
      isHub && "device" in caller
        ? new Set((caller.device.clinic_ids as unknown as string[]) ?? [])
        : null;

    const outcome: PushOutcome = { accepted: 0, rejected: {}, byTable: {} };

    /**
     * Record one record's fate, keyed by the name the CLIENT knows the table
     * by. The client feeds `rejected` straight into WatermelonDB's
     * `markLocalChangesAsSynced`, which resolves collections by mobile name, so
     * keying this by the server name would silently protect nothing.
     */
    const note = (mobileTable: string, id: string, accepted: boolean) => {
      outcome.byTable[mobileTable] ??= { accepted: 0, rejected: 0 };
      if (accepted) {
        outcome.accepted += 1;
        outcome.byTable[mobileTable].accepted += 1;
      } else {
        outcome.byTable[mobileTable].rejected += 1;
        (outcome.rejected[mobileTable] ??= []).push(id);
      }
    };

    // Warm the schema-driven date-column map before iterating records — the
    // coercion below depends on it. Cached after the first call.
    await loadDateColumnsByTable();

    // Process the delta data from the client.
    // Iterate over the entity list (not Object.entries) to guarantee
    // dependency order: patients → patient_additional_attributes → visits → events → …
    for (const entity of entitiesToPull) {
      const tableName = entity.Table.name;
      // `Device.Table` declares no mobileName; falling back to the server name
      // keeps its records out of an `outcome.rejected["undefined"]` bucket.
      const mobileName = entity.Table.mobileName ?? tableName;
      const reportable = REPORTABLE_TABLES.has(tableName);
      const newDeltaJson = (data as Record<string, DeltaData>)[tableName];
      if (!newDeltaJson) {
        continue;
      }
      Logger.log(`Processing table: ${tableName}`);
      // Get the entity delta values with defaults
      const deltaData = {
        created: newDeltaJson?.created || [],
        updated: newDeltaJson?.updated || [],
        deleted: newDeltaJson?.deleted || [],
      };

      const knownColumns = new Set(
        Object.keys(tableModelMap[tableName].Table.columns),
      );

      for (const record of deltaData.created.concat(deltaData.updated)) {
        // Strip unknown columns (e.g. WatermelonDB's _status, _changed) and
        // convert raw epoch timestamps to ISO strings so PostgreSQL can parse them.
        const cleaned = Object.fromEntries(
          Object.entries(record)
            .filter(([key]) => {
              if (knownColumns.has(key)) return true;
              Logger.warn(
                `[sync] Ignoring unknown column "${key}" for table "${tableName}"`,
              );
              return false;
            })
            .map(([key, value]) => {
              // Only coerce numeric values into ISO strings on actual date
              // columns. Without the column gate, 10-13 digit phone numbers
              // / government IDs / external patient IDs trip the epoch regex
              // and overwrite their text columns with ISO timestamps.
              if (isDateColumn(tableName, key) && isEpochTimestamp(value)) {
                Logger.warn(
                  `[sync] Converting epoch timestamp in "${tableName}.${key}": ${value}`,
                );
                return [key, toSafeDateString(value)];
              }
              // Mobile clients may send 0/"0" for empty date fields — coerce to null
              if (
                (value === 0 || value === "0") &&
                isDateColumn(tableName, key)
              ) {
                Logger.warn(
                  `[sync] Converting zero date to null in "${tableName}.${key}"`,
                );
                return [key, null];
              }
              return [key, value];
            }),
        );

        // Hub authorization: reject records targeting clinics the hub isn't assigned to
        if (
          hubAuthorizedClinicIds &&
          !isRecordAuthorizedForClinic(
            cleaned,
            tableName,
            hubAuthorizedClinicIds,
          )
        ) {
          const clinicColumn = CLINIC_COLUMN_BY_TABLE[tableName];
          Logger.warn(
            `[sync] Hub not authorized to push "${tableName}" record ${cleaned.id} — ` +
              `clinic ${cleaned[clinicColumn!]} not in hub's authorized clinics`,
          );
          if (reportable) note(mobileName, String(cleaned.id), false);
          continue;
        }

        let upsertResult: unknown;
        try {
          upsertResult = await tableModelMap[tableName].Sync.upsertFromDelta(
            cleaned as any,
            caller,
          );
        } catch (error) {
          const code = recordLevelErrorCode(error);
          // Skipping is only safe when the client will be told, since it then
          // keeps the record pending. On a table whose rejections it never sees,
          // dropping the record here would lose it outright.
          if (code === null || !reportable) throw error;
          Logger.error({
            msg:
              `[sync] Postgres rejected ${tableName} record ${cleaned.id} (${code}) — ` +
              `skipping it so the rest of the push can land`,
            error,
          });
          note(mobileName, String(cleaned.id), false);
          continue;
        }
        if (reportable) {
          note(
            mobileName,
            String(cleaned.id),
            classifyUpsertResult(upsertResult),
          );
        }
      }

      for (const id of deltaData.deleted) {
        try {
          await tableModelMap[tableName].Sync.deleteFromDelta(id);
        } catch (error) {
          const code = recordLevelErrorCode(error);
          // Same rule as the upsert above. Reporting the id keeps the client's
          // tombstone alive: WatermelonDB's `destroyDeletedRecords` filters the
          // deleted bucket by `rejectedIds`, so the deletion is retried.
          if (code === null || !reportable) throw error;
          Logger.error({
            msg:
              `[sync] Postgres rejected the deletion of ${tableName} ${id} (${code}) — ` +
              `skipping it so the rest of the push can land`,
            error,
          });
          note(mobileName, id, false);
        }
      }
    }

    // Warn about any tables the client sent that we don't recognize
    const knownTableNames = new Set(entitiesToPull.map((e) => e.Table.name));
    for (const tableName of Object.keys(data)) {
      if (!knownTableNames.has(tableName)) {
        Logger.warn(
          `[sync] Table "${tableName}" not found in accepted entities for ${isHub ? "hub" : "mobile"} - ignoring`,
        );
      }
    }

    Logger.log("Finished persisting client changes");
    return outcome;
  };
}

export default Sync;
