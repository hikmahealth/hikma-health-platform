import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  type JSONColumnType,
  sql,
  type Kysely,
} from "kysely";
import { uuidv7 } from "uuidv7";
import { createHash } from "crypto";
import type { IncomingMessage } from "http";
import { safeJSONParse, toSafeDateString } from "@/lib/utils";

namespace EventLog {
  export type ActionType =
    | "CREATE"
    | "UPDATE"
    | "SOFT_DELETE"
    | "PERMANENT_DELETE"
    | "VIEW"
    | "EXPORT"
    | "SIGN_IN"
    | "SIGN_IN_FAILED"
    | "SIGN_OUT";

  export const actionTypeValues = [
    "CREATE",
    "UPDATE",
    "SOFT_DELETE",
    "PERMANENT_DELETE",
    "VIEW",
    "EXPORT",
    "SIGN_IN",
    "SIGN_IN_FAILED",
    "SIGN_OUT",
  ] as const;

  export interface T {
    id: string;
    transaction_id: string;
    action_type: ActionType;
    table_name: string;
    row_id: string;
    changes: Record<string, unknown>;
    device_id: string;
    app_id: string;
    user_id: string;
    ip_address: string | null;
    hash: string;
    hash_verified: boolean | null;
    metadata: Record<string, unknown>;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
    last_modified: Date;
    server_created_at: Date;
    deleted_at: Date | null;
  }

  /**
   * Encoded type for sync operations.
   * This is what mobile clients send when pushing event logs.
   */
  export type EncodedT = {
    id: string;
    transaction_id: string;
    action_type: ActionType;
    table_name: string;
    row_id: string;
    changes: Record<string, unknown> | string;
    device_id: string;
    app_id: string;
    user_id: string;
    ip_address: string | null;
    hash: string;
    hash_verified: boolean | null;
    metadata: Record<string, unknown> | string;
    is_deleted: boolean;
    created_at: Date | string;
    updated_at: Date | string;
    last_modified: Date | string;
    server_created_at: Date | string;
    deleted_at: Date | string | null;
  };

  // ============================================
  // Types for Server-side Event Logging
  // ============================================

  export interface LogEventParams {
    /** Shared transaction ID to group related changes. Auto-generated if not provided. */
    transactionId?: string;
    actionType: ActionType;
    tableName: string;
    rowId: string;
    /** For CREATE: { row_id }, for UPDATE: { field: { old, new } }, etc. */
    changes: Record<string, unknown>;
    userId: string;
    metadata?: Record<string, unknown> | null;
  }

  /**
   * Context extracted from the incoming HTTP request.
   * Pass this from your middleware/route handler.
   */
  export interface RequestContext {
    /**
     * IP address — extracted from x-forwarded-for (if behind a proxy/load balancer)
     * or from the request socket. Your reverse proxy must be configured to set
     * x-forwarded-for for this to be accurate.
     */
    ipAddress: string | null;

    /**
     * Device ID — SHA-256 hash of the User-Agent header.
     * For the web client, there is no persistent device ID like on mobile,
     * so we use a UA hash as a best-effort device fingerprint.
     * This is NOT unique per device (multiple users on the same browser
     * will share a device_id), but it's sufficient for audit grouping.
     */
    deviceId: string;

    /**
     * App ID — static "web" identifier for the web client.
     * Mobile clients provide their own install-unique app_id.
     * This distinguishes web-originated events from mobile-originated ones.
     */
    appId: string;
  }

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     *
     * NOTE: Event logs are ONE-WAY: mobile pushes TO server, but never receives updates.
     * This is an append-only audit log - mobile clients create logs locally and sync them up.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = false;
    export const name = "event_logs";

    /** The name of the table in the mobile database */
    export const mobileName = "event_logs";

    export const columns = {
      id: "id",
      transaction_id: "transaction_id",
      action_type: "action_type",
      table_name: "table_name",
      row_id: "row_id",
      changes: "changes",
      device_id: "device_id",
      app_id: "app_id",
      user_id: "user_id",
      ip_address: "ip_address",
      hash: "hash",
      hash_verified: "hash_verified",
      metadata: "metadata",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
    };

    export interface T {
      id: string; // UUIDv7, always provided by app
      transaction_id: string;
      action_type: ActionType;
      table_name: string;
      row_id: string;
      changes: JSONColumnType<Record<string, unknown>>;
      device_id: string;
      app_id: string;
      user_id: string;
      ip_address: string | null;
      hash: string;
      hash_verified: boolean | null;
      metadata: JSONColumnType<Record<string, unknown>>;
      is_deleted: Generated<boolean>;
      created_at: Generated<ColumnType<Date, string | undefined, never>>;
      updated_at: Generated<
        ColumnType<Date, string | undefined, string | undefined>
      >;
      last_modified: Generated<ColumnType<Date, string | undefined, never>>;
      server_created_at: Generated<ColumnType<Date, string | undefined, never>>;
      deleted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
    }

    export type EventLogs = Selectable<T>;
    export type NewEventLogs = Insertable<T>;
    export type EventLogsUpdate = Updateable<T>;
  }

  export namespace API {
    export const getAll = createServerOnlyFn(
      async (): Promise<EventLog.T[]> => {
        const res = await db
          .selectFrom(EventLog.Table.name)
          .where("is_deleted", "=", false)
          .selectAll()
          .execute();

        return res as unknown as EventLog.T[];
      },
    );

    export const getById = createServerOnlyFn(async (id: string) => {
      const res = await db
        .selectFrom(EventLog.Table.name)
        .where("id", "=", id)
        .where("is_deleted", "=", false)
        .selectAll()
        .executeTakeFirst();

      return res as unknown as EventLog.T | null;
    });

    export const getByTransactionId = createServerOnlyFn(
      async (transactionId: string) => {
        const res = await db
          .selectFrom(EventLog.Table.name)
          .where("transaction_id", "=", transactionId)
          .where("is_deleted", "=", false)
          .selectAll()
          .execute();

        return res as unknown as EventLog.T[];
      },
    );

    export const getByTableName = createServerOnlyFn(
      async (tableName: string) => {
        const res = await db
          .selectFrom(EventLog.Table.name)
          .where("table_name", "=", tableName)
          .where("is_deleted", "=", false)
          .selectAll()
          .orderBy("created_at", "desc")
          .execute();

        return res as unknown as EventLog.T[];
      },
    );

    export const getByRowId = createServerOnlyFn(
      async (tableName: string, rowId: string) => {
        const res = await db
          .selectFrom(EventLog.Table.name)
          .where("table_name", "=", tableName)
          .where("row_id", "=", rowId)
          .where("is_deleted", "=", false)
          .selectAll()
          .orderBy("created_at", "desc")
          .execute();

        return res as unknown as EventLog.T[];
      },
    );

    export const getByUserId = createServerOnlyFn(async (userId: string) => {
      const res = await db
        .selectFrom(EventLog.Table.name)
        .where("user_id", "=", userId)
        .where("is_deleted", "=", false)
        .selectAll()
        .orderBy("created_at", "desc")
        .execute();

      return res as unknown as EventLog.T[];
    });

    /**
     * Insert event log from mobile sync.
     * This is INSERT-ONLY - event logs are immutable and cannot be updated.
     * Uses onConflict to ignore duplicates (idempotent for sync retries).
     */
    export const insertFromSync = createServerOnlyFn(
      async (eventLog: EventLog.EncodedT) => {
        // Use safeJSONParse to handle malformed JSON from mobile clients gracefully
        const changes = JSON.stringify(safeJSONParse(eventLog.changes, {}));
        const metadata = JSON.stringify(safeJSONParse(eventLog.metadata, {}));

        return await db
          .insertInto(EventLog.Table.name)
          .values({
            id: eventLog.id,
            transaction_id: eventLog.transaction_id,
            action_type: eventLog.action_type,
            table_name: eventLog.table_name,
            row_id: eventLog.row_id,
            changes: sql`${changes}::jsonb`,
            device_id: eventLog.device_id,
            app_id: eventLog.app_id,
            user_id: eventLog.user_id,
            ip_address: eventLog.ip_address,
            hash: eventLog.hash,
            hash_verified: null, // Will be verified by cron job
            metadata: sql`${metadata}::jsonb`,
            is_deleted: false,
            created_at: sql`${toSafeDateString(eventLog.created_at)}::timestamp with time zone`,
            updated_at: sql`${toSafeDateString(eventLog.updated_at)}::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
            server_created_at: sql`now()::timestamp with time zone`,
            deleted_at: null,
          })
          .onConflict((oc) =>
            // Event logs are immutable - if ID already exists, do nothing (idempotent)
            oc.column("id").doNothing(),
          )
          .execute();
      },
    );
  }

  // ============================================
  // Sync Namespace
  // Mobile clients push event logs to server (one-way sync).
  // Event logs are never sent back to mobile devices.
  // ============================================

  export namespace Sync {
    /**
     * Upsert event log from mobile sync delta.
     * Note: This is effectively INSERT-ONLY due to immutability triggers.
     * Duplicates are ignored (idempotent for sync retries).
     */
    export const upsertFromDelta = createServerOnlyFn(
      async (delta: EventLog.EncodedT) => {
        return API.insertFromSync(delta);
      },
    );

    /**
     * Delete is a no-op for event logs.
     * Event logs are immutable and cannot be deleted.
     * This method exists only to satisfy the sync interface.
     */
    export const deleteFromDelta = createServerOnlyFn(async (_id: string) => {
      // Event logs are immutable - deletes are not permitted.
      // The database trigger will block any actual delete attempts.
      // We silently ignore delete requests from sync.
      return;
    });
  }

  // ============================================
  // Server-side Event Logger Helpers
  // ============================================

  /**
   * Extract request context from an incoming HTTP request.
   * Call this once per request in your middleware and pass it through.
   *
   * Usage:
   *   const ctx = EventLog.extractRequestContext(req);
   *   await EventLog.logEvent(db, { ...params }, ctx);
   */
  export function extractRequestContext(req: IncomingMessage): RequestContext {
    // IP: prefer x-forwarded-for (first entry) for proxied setups, fall back to socket
    const forwarded = req.headers["x-forwarded-for"];
    const forwardedIp =
      typeof forwarded === "string"
        ? forwarded.split(",")[0]?.trim()
        : Array.isArray(forwarded)
          ? forwarded[0]?.split(",")[0]?.trim()
          : null;
    const ipAddress = forwardedIp || req.socket?.remoteAddress || null;

    // Device ID: SHA-256 of User-Agent as a best-effort device fingerprint
    const userAgent = req.headers["user-agent"] ?? "unknown";
    const deviceId = createHash("sha256").update(userAgent).digest("hex");

    return {
      ipAddress,
      deviceId,
      appId: "web",
    };
  }

  /**
   * Compute SHA-256 hash for an event log entry.
   * Used for integrity verification.
   */
  export function computeHash(data: {
    id: string;
    transactionId: string;
    actionType: string;
    tableName: string;
    rowId: string;
    changes: string;
    deviceId: string;
    appId: string;
    userId: string;
    ipAddress: string | null;
    createdAt: number;
  }): string {
    const payload = [
      data.id,
      data.transactionId,
      data.actionType,
      data.tableName,
      data.rowId,
      data.changes,
      data.deviceId,
      data.appId,
      data.userId,
      data.ipAddress ?? "",
      data.createdAt.toString(),
    ].join("|");

    return createHash("sha256").update(payload).digest("hex");
  }

  // ============================================
  // Core Logging Functions
  // ============================================

  /**
   * Log a single audit event from the web client.
   *
   * @param database - Kysely database instance
   * @param params   - Event data (action, table, changes, user)
   * @param ctx      - Request context from extractRequestContext()
   */
  export async function logEvent(
    database: Kysely<{ event_logs: EventLog.Table.T }>,
    params: LogEventParams,
    ctx: RequestContext,
  ): Promise<void> {
    const id = uuidv7();
    const transactionId = params.transactionId ?? uuidv7();
    const changesStr = JSON.stringify(params.changes);
    const createdAt = Date.now();

    const hash = computeHash({
      id,
      transactionId,
      actionType: params.actionType,
      tableName: params.tableName,
      rowId: params.rowId,
      changes: changesStr,
      deviceId: ctx.deviceId,
      appId: ctx.appId,
      userId: params.userId,
      ipAddress: ctx.ipAddress,
      createdAt,
    });

    const metadataStr = params.metadata
      ? JSON.stringify(params.metadata)
      : "{}";

    await database
      .insertInto("event_logs")
      .values({
        id,
        transaction_id: transactionId,
        action_type: params.actionType,
        table_name: params.tableName,
        row_id: params.rowId,
        changes: sql`${changesStr}::jsonb`,
        device_id: ctx.deviceId,
        app_id: ctx.appId,
        user_id: params.userId,
        ip_address: ctx.ipAddress,
        hash,
        metadata: sql`${metadataStr}::jsonb`,
        created_at: sql`${new Date(createdAt).toISOString()}::timestamp with time zone`,
      })
      .execute();
  }

  /**
   * Log multiple audit events in a single transaction.
   * All events share the same transaction_id unless individually overridden.
   *
   * @param database            - Kysely database instance
   * @param events              - Array of event data
   * @param ctx                 - Request context from extractRequestContext()
   * @param sharedTransactionId - Optional shared transaction ID for all events
   */
  export async function logEvents(
    database: Kysely<{ event_logs: EventLog.Table.T }>,
    events: LogEventParams[],
    ctx: RequestContext,
    sharedTransactionId?: string,
  ): Promise<void> {
    if (events.length === 0) return;

    const txId = sharedTransactionId ?? uuidv7();
    const createdAt = Date.now();
    const createdAtStr = new Date(createdAt).toISOString();

    const rows = events.map((params) => {
      const id = uuidv7();
      const transactionId = params.transactionId ?? txId;
      const changesStr = JSON.stringify(params.changes);

      const hash = computeHash({
        id,
        transactionId,
        actionType: params.actionType,
        tableName: params.tableName,
        rowId: params.rowId,
        changes: changesStr,
        deviceId: ctx.deviceId,
        appId: ctx.appId,
        userId: params.userId,
        ipAddress: ctx.ipAddress,
        createdAt,
      });

      const metadataStr = params.metadata
        ? JSON.stringify(params.metadata)
        : "{}";

      return {
        id,
        transaction_id: transactionId,
        action_type: params.actionType,
        table_name: params.tableName,
        row_id: params.rowId,
        changes: sql`${changesStr}::jsonb`,
        device_id: ctx.deviceId,
        app_id: ctx.appId,
        user_id: params.userId,
        ip_address: ctx.ipAddress,
        hash,
        metadata: sql`${metadataStr}::jsonb`,
        created_at: sql`${createdAtStr}::timestamp with time zone`,
      };
    });

    // Batch insert — single query, much faster than N individual inserts
    await database.insertInto("event_logs").values(rows).execute();
  }

  // ============================================
  // Hash Verification Job — run weekly via cron
  // ============================================
  export async function verifyHashes(database: Kysely<any>): Promise<{
    verified: number;
    failed: number;
  }> {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(database);

    const result = await sql<{ total: number; failed: number }>`
      WITH unverified AS (
        SELECT
          id,
          hash,
          encode(
            digest(
              concat_ws('|',
                id::text,
                transaction_id::text,
                action_type,
                table_name,
                row_id,
                changes::text,
                device_id,
                app_id,
                user_id,
                COALESCE(ip_address::text, ''),
                (extract(epoch from created_at) * 1000)::bigint::text
              ),
              'sha256'
            ),
            'hex'
          ) AS computed_hash
        FROM event_logs
        WHERE hash_verified IS NULL
        LIMIT 10000
      ),
      updated AS (
        UPDATE event_logs e
        SET hash_verified = (u.hash = u.computed_hash)
        FROM unverified u
        WHERE e.id = u.id
        RETURNING e.hash_verified
      )
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE hash_verified = false)::int AS failed
      FROM updated
    `.execute(database);

    const row = result.rows[0];
    return {
      verified: (row?.total ?? 0) - (row?.failed ?? 0),
      failed: row?.failed ?? 0,
    };
  }

  // ============================================
  // Archive Helper — export old data to CSV
  // ============================================
  export async function archiveOldLogs(
    database: Kysely<any>,
    olderThan: Date,
    exportPath: string,
  ): Promise<void> {
    const dateStr = olderThan.toISOString();

    await sql`
      COPY (
        SELECT * FROM event_logs WHERE created_at < ${dateStr}::timestamptz
      ) TO ${exportPath} WITH (FORMAT csv, HEADER true)
    `.execute(database);
  }
}

export default EventLog;

// ============================================
// EXAMPLES FOR LATER
// ============================================
/*

// Route example: update a patient record
app.put("/api/patients/:id", async (req, res) => {
  const ctx: EventLog.RequestContext = res.locals.eventCtx;
  const userId = req.user.id; // from your auth middleware

  // ... perform the actual update ...

  await EventLog.logEvent(
    db,
    {
      actionType: "UPDATE",
      tableName: "patients",
      rowId: req.params.id,
      changes: {
        first_name: { old: "Jon", new: "Jonathan" },
        last_name: { old: "Doe", new: "Doe" },
      },
      userId,
    },
    ctx,
  );

  res.json({ success: true });
});
*/
