import { Option } from "effect";
import type {
  ColumnType,
  Generated,
  Selectable,
  Insertable,
  Updateable,
  JSONColumnType,
} from "kysely";
import { sql } from "kysely";
import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import { v7 as uuidV7 } from "uuid";
import { createHash } from "node:crypto";

namespace ServerVariable {
  export type ValueType = "string" | "number" | "boolean" | "blob" | "json";

  /** Well-known server variable keys */
  export const Keys = {
    HH_STORE_TYPE: "hh_store_type",
    AWS_ACCESS_KEY_ID: "aws_access_key_id",
    AWS_SECRET_ACCESS_KEY: "aws_secret_access_key",
    AWS_REGION: "aws_region",
    AWS_ENDPOINT_URL_S3: "aws_endpoint_url_s3",
    S3_BUCKET_NAME: "s3_bucket_name",
    // Tigris keeps its own keys rather than reusing the AWS ones, so the two
    // S3-compatible backends can be configured at the same time and files
    // written under either stay readable. See storage/adapters/s3.ts.
    TIGRIS_ACCESS_KEY_ID: "tigris_access_key_id",
    TIGRIS_SECRET_ACCESS_KEY: "tigris_secret_access_key",
    TIGRIS_REGION: "tigris_region",
    TIGRIS_BUCKET_NAME: "tigris_bucket_name",
    TIGRIS_ENDPOINT_URL: "tigris_endpoint_url",
    GCP_SERVICE_ACCOUNT: "gcp_service_account",
    GCP_BUCKET_NAME: "gcp_bucket_name",
    AZURE_STORAGE_CONNECTION_STRING: "azure_storage_connection_string",
    AZURE_CONTAINER_NAME: "azure_container_name",
    DISK_STORAGE_PATH: "disk_storage_path",
    AI_DATA_ANALYSIS_URL: "ai_data_analysis_url",
    AI_PROXY_SERVICE_API_KEY: "ai_proxy_service_api_key",
    ANTHROPIC_API_KEY: "anthropic_api_key",
    OPENAI_API_KEY: "openai_api_key",
    GEMINI_API_KEY: "gemini_api_key",
  } as const;

  export type T = {
    id: string;
    key: string;
    description: Option.Option<string>;
    value_type: string;
    value_data: Option.Option<Uint8Array>;
    value_hash: Option.Option<string>;
    created_at: Date;
    updated_at: Date;
  };

  export namespace Table {
    export const name = "server_variables";
    export const columns = {
      id: "id",
      key: "key",
      description: "description",
      value_type: "value_type",
      value_data: "value_data",
      value_hash: "value_hash",
      created_at: "created_at",
      updated_at: "updated_at",
    };

    export interface T {
      id: string;
      key: string;
      description: string | null;
      value_type: string;
      value_data: Uint8Array | null;
      value_hash: string | null;
      created_at: Generated<ColumnType<Date, string | undefined, never>>;
      updated_at: Generated<
        ColumnType<Date, string | undefined, string | undefined>
      >;
    }

    export type ServerVariables = Selectable<T>;
    export type NewServerVariables = Insertable<T>;
    export type ServerVariablesUpdate = Updateable<T>;
  }

  /** Retrieve a server variable by its unique key. Returns null if not found. */
  export const get = createServerOnlyFn(
    async (key: string): Promise<Table.ServerVariables | null> => {
      const row = await db
        .selectFrom(Table.name)
        .where("key", "=", key)
        .selectAll()
        .executeTakeFirst();
      return row ?? null;
    },
  );

  /** Upsert a server variable by key. Creates if missing, updates if exists. */
  export const update = createServerOnlyFn(
    async (
      variable: Pick<Table.NewServerVariables, "key" | "value_type"> &
        Partial<
          Pick<
            Table.NewServerVariables,
            "description" | "value_data" | "value_hash"
          >
        >,
    ): Promise<string> => {
      const id = uuidV7();
      const result = await db
        .insertInto(Table.name)
        .values({
          id,
          key: variable.key,
          value_type: variable.value_type,
          description: variable.description ?? null,
          value_data: variable.value_data ?? null,
          value_hash: variable.value_hash ?? null,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({
            value_type: variable.value_type,
            description: variable.description ?? null,
            value_data: variable.value_data ?? null,
            value_hash: variable.value_hash ?? null,
            updated_at: sql`now()`,
          }),
        )
        .returning("id")
        .executeTakeFirstOrThrow();

      return result.id;
    },
  );

  // --- Typed helpers ---
  // These build on the raw get/update above to provide type-safe access
  // to server variables without callers needing to handle encoding.

  const sha256 = (data: Uint8Array): string =>
    createHash("sha256").update(data).digest("hex");

  const normalizeKey = (key: string): string => key.toLowerCase();

  /** Core setter: encodes value as bytes, computes SHA-256 hash, upserts. */
  export const setPrimitive = createServerOnlyFn(
    async (
      key: string,
      value: Uint8Array,
      valueType: ValueType,
      description?: string,
    ): Promise<string> => {
      return update({
        key: normalizeKey(key),
        value_type: valueType,
        value_data: value,
        value_hash: sha256(value),
        description: description ?? null,
      });
    },
  );

  export const setString = createServerOnlyFn(
    async (key: string, value: string, description?: string): Promise<string> =>
      setPrimitive(key, new TextEncoder().encode(value), "string", description),
  );

  export const setJson = createServerOnlyFn(
    async (
      key: string,
      value: unknown,
      description?: string,
    ): Promise<string> =>
      setPrimitive(
        key,
        new TextEncoder().encode(JSON.stringify(value)),
        "json",
        description,
      ),
  );

  export const setNumber = createServerOnlyFn(
    async (key: string, value: number, description?: string): Promise<string> =>
      setPrimitive(
        key,
        new TextEncoder().encode(String(value)),
        "number",
        description,
      ),
  );

  export const setBoolean = createServerOnlyFn(
    async (
      key: string,
      value: boolean,
      description?: string,
    ): Promise<string> =>
      setPrimitive(
        key,
        new Uint8Array([value ? 1 : 0]),
        "boolean",
        description,
      ),
  );

  /** Get a server variable's value decoded as a string. Returns null if not found. */
  export const getAsString = createServerOnlyFn(
    async (key: string): Promise<string | null> => {
      const row = await get(normalizeKey(key));
      if (!row?.value_data) return null;
      return new TextDecoder().decode(row.value_data);
    },
  );

  /**
   * Fetch several server variables in one query, decoded as strings. Keys with
   * no row, or a row with no value, map to null.
   */
  export const getManyAsStrings = createServerOnlyFn(
    async (
      keys: readonly string[],
    ): Promise<Record<string, string | null>> => {
      const normalized = keys.map(normalizeKey);
      const values: Record<string, string | null> = {};
      for (const key of normalized) {
        values[key] = null;
      }
      if (normalized.length === 0) return values;

      const rows = await db
        .selectFrom(Table.name)
        .select(["key", "value_data"])
        .where("key", "in", normalized)
        .execute();

      const decoder = new TextDecoder();
      for (const row of rows) {
        values[row.key] = row.value_data ? decoder.decode(row.value_data) : null;
      }
      return values;
    },
  );

  /**
   * Clear a variable's value without removing the row, so a rotated-out
   * credential can be revoked rather than only overwritten.
   */
  export const clearValue = createServerOnlyFn(
    async (key: string): Promise<void> => {
      await db
        .updateTable(Table.name)
        .set({ value_data: null, value_hash: null, updated_at: sql`now()` })
        .where("key", "=", normalizeKey(key))
        .execute();
    },
  );

  /** Get a server variable's value decoded as parsed JSON. Returns null if not found. */
  export const getAsJson = createServerOnlyFn(
    async <T = unknown>(key: string): Promise<T | null> => {
      const row = await get(normalizeKey(key));
      if (!row?.value_data) return null;
      if (row.value_type !== "json") {
        throw new Error(
          `ServerVariable "${key}" has type "${row.value_type}", expected "json"`,
        );
      }
      return JSON.parse(new TextDecoder().decode(row.value_data)) as T;
    },
  );

  /** Get a server variable's value decoded as a number. Returns null if not found. */
  export const getAsNumber = createServerOnlyFn(
    async (key: string): Promise<number | null> => {
      const raw = await getAsString(key);
      if (raw === null) return null;
      const num = Number(raw);
      if (Number.isNaN(num)) {
        throw new Error(
          `ServerVariable "${key}" is not a valid number: "${raw}"`,
        );
      }
      return num;
    },
  );

  /** Get a server variable's value decoded as a boolean. Returns null if not found. */
  export const getAsBoolean = createServerOnlyFn(
    async (key: string): Promise<boolean | null> => {
      const row = await get(normalizeKey(key));
      if (!row?.value_data) return null;
      return row.value_data[0] === 1;
    },
  );
}

export default ServerVariable;
