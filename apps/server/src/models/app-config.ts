import { Either, Option, Schema } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  sql,
} from "kysely";
import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";

namespace AppConfig {
  export const DataTypeSchema = Schema.Union(
    Schema.Literal("string"),
    Schema.Literal("number"),
    Schema.Literal("boolean"),
    Schema.Literal("json"),
    Schema.Literal("array"),
  );

  export const AppConfigSchema = Schema.Struct({
    namespace: Schema.String,
    key: Schema.String,
    display_name: Schema.NullOr(Schema.String),
    value: Schema.NullOr(Schema.String),
    data_type: DataTypeSchema,
    created_at: Schema.DateFromSelf,
    updated_at: Schema.DateFromSelf,
    last_modified: Schema.DateFromSelf,
    last_modified_by: Schema.NullOr(Schema.String),
    clinic_ids: Schema.NullOr(Schema.Array(Schema.String)),
  });

  /** Common configuration namespaces */
  export const Namespaces = {
    UI: "ui",
    SYNC: "sync",
    FEATURE_FLAGS: "feature_flags",
    SYSTEM: "system",
    CLINIC: "clinic",
    ORGANIZATION: "organization",
    AUTH: "auth",
  } as const;

  export type NamespacesT = (typeof Namespaces)[keyof typeof Namespaces];

  export type T = typeof AppConfigSchema.Type;
  export type EncodedT = typeof AppConfigSchema.Encoded;
  export type DataTypeT = typeof DataTypeSchema.Type;

  export const fromDbEntry = (
    entry: AppConfig.Table.AppConfigs,
  ): Either.Either<AppConfig.T, Error> => {
    return Schema.decodeUnknownEither(AppConfigSchema)(entry);
  };

  export namespace Table {
    export const name = "app_config";
    /** The name of the table in the mobile database */
    export const mobileName = "app_config";

    export const columns = {
      namespace: "namespace",
      key: "key",
      display_name: "display_name",
      value: "value",
      data_type: "data_type",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      last_modified_by: "last_modified_by",
      clinic_ids: "clinic_ids",
    };

    export interface T {
      namespace: string;
      key: string;
      display_name: string | null;
      value: string | null;
      data_type: string;
      created_at: Generated<Date>;
      updated_at: Generated<Date>;
      last_modified: Generated<Date>;
      last_modified_by: string | null;
      /**
       * Not `JSONColumnType<string[] | null>`, which pins the write types at
       * `string` and so rejects the SQL NULL this table uses for "all clinics".
       */
      clinic_ids: ColumnType<string[] | null, string | null, string | null>;
    }

    export type AppConfigs = Selectable<T>;
    export type NewAppConfigs = Insertable<T>;
    export type AppConfigsUpdate = Updateable<T>;
  }

  export namespace API {
    /**
     * Get a configuration value by namespace and key
     * @param {string} namespace - The namespace of the configuration
     * @param {string} key - The key of the configuration
     * @returns {Promise<AppConfig.EncodedT | null>} - The configuration entry
     */
    export const get = createServerOnlyFn(
      async (
        namespace: string,
        key: string,
      ): Promise<AppConfig.EncodedT | null> => {
        const result = await db
          .selectFrom(AppConfig.Table.name)
          .where("namespace", "=", namespace)
          .where("key", "=", key)
          .selectAll()
          .executeTakeFirst();

        return result || null;
      },
    );

    /**
     * Get a parsed configuration value, honouring the row's clinic scope.
     * Null when no row exists or the row does not apply — flags fail closed.
     */
    export const getScopedValue = createServerOnlyFn(
      async <T>(
        namespace: string,
        key: string,
        clinicId: string | null,
      ): Promise<T | null> => {
        const row = await get(namespace, key);
        if (!row) return null;
        if (!Utils.appliesToClinic(row.clinic_ids, clinicId)) return null;
        return Utils.parseValue(row);
      },
    );

    /**
     * Get all configuration values for a namespace
     * @param {string} namespace - The namespace to retrieve configurations for
     * @returns {Promise<AppConfig.EncodedT[]>} - All configurations in the namespace
     */
    export const getByNamespace = createServerOnlyFn(
      async (namespace: string): Promise<AppConfig.EncodedT[]> => {
        const result = await db
          .selectFrom(AppConfig.Table.name)
          .where("namespace", "=", namespace)
          .selectAll()
          .orderBy("key", "asc")
          .execute();

        return result;
      },
    );

    /**
     * Get all configuration values
     * @returns {Promise<AppConfig.EncodedT[]>} - All configuration entries
     */
    export const getAll = createServerOnlyFn(
      async (): Promise<AppConfig.EncodedT[]> => {
        const result = await db
          .selectFrom(AppConfig.Table.name)
          .selectAll()
          .orderBy("namespace", "asc")
          .orderBy("key", "asc")
          .execute();

        return result;
      },
    );

    /**
     * Set a configuration value
     * @param {string} namespace - The namespace of the configuration
     * @param {string} key - The key of the configuration
     * @param {string | null} value - The value to set
     * @param {AppConfig.DataTypeT} dataType - The data type of the value
     * @param {string | null} updatedBy - The ID of the user making the update
     * @param {string[] | null | undefined} clinicIds - The clinic scope. An
     *   array scopes the row to those clinics, `null` to all clinics, and
     *   omitting it leaves an existing row's scope untouched. Callers that do
     *   not manage scope must omit it rather than pass `null`, or every write
     *   through them silently unscopes the row.
     * @returns {Promise<AppConfig.EncodedT>} - The created/updated configuration
     */
    export const set = createServerOnlyFn(
      async (
        namespace: string,
        key: string,
        displayName: string | null,
        value: string | null | number | boolean | unknown[],
        dataType: AppConfig.DataTypeT,
        updatedBy: string | null = null,
        clinicIds?: string[] | null,
      ): Promise<AppConfig.EncodedT> => {
        const managesScope = clinicIds !== undefined;

        const result = await db
          .insertInto(AppConfig.Table.name)
          .values({
            namespace,
            key,
            display_name: displayName,
            value: Utils.serializeValue(value, dataType),
            data_type: dataType,
            // SQL NULL for "all clinics", an explicit ::jsonb cast otherwise.
            // Never the bare array — node-pg renders it as a Postgres array
            // literal ({a,b}), not JSON.
            clinic_ids:
              clinicIds === undefined || clinicIds === null
                ? null
                : sql`${JSON.stringify(clinicIds)}::jsonb`,
            last_modified_by: updatedBy,
            created_at: sql`now()::timestamp with time zone`,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
          })
          .onConflict((oc) =>
            oc.columns(["namespace", "key"]).doUpdateSet({
              display_name: (eb) => eb.ref("excluded.display_name"),
              value: (eb) => eb.ref("excluded.value"),
              data_type: (eb) => eb.ref("excluded.data_type"),
              // Only when the caller manages scope; updating unconditionally
              // would let a scope-unaware caller reset an existing row to "all
              // clinics" on every ordinary value edit.
              ...(managesScope
                ? { clinic_ids: sql.ref("excluded.clinic_ids") }
                : {}),
              last_modified_by: updatedBy,
              updated_at: sql`now()::timestamp with time zone`,
              last_modified: sql`now()::timestamp with time zone`,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();

        return result;
      },
    );

    /**
     * Delete a configuration entry
     * @param {string} namespace - The namespace of the configuration
     * @param {string} key - The key of the configuration
     * @returns {Promise<void>} - Resolves when the configuration is deleted
     */
    export const remove = createServerOnlyFn(
      async (namespace: string, key: string): Promise<void> => {
        await db
          .deleteFrom(AppConfig.Table.name)
          .where("namespace", "=", namespace)
          .where("key", "=", key)
          .execute();
      },
    );

    /**
     * Delete all configurations in a namespace
     * @param {string} namespace - The namespace to clear
     * @returns {Promise<void>} - Resolves when all configurations are deleted
     */
    export const clearNamespace = createServerOnlyFn(
      async (namespace: string): Promise<void> => {
        await db
          .deleteFrom(AppConfig.Table.name)
          .where("namespace", "=", namespace)
          .execute();
      },
    );

    /**
     * Get all unique namespaces
     * @returns {Promise<string[]>} - List of unique namespaces
     */
    export const getNamespaces = createServerOnlyFn(
      async (): Promise<string[]> => {
        const result = await db
          .selectFrom(AppConfig.Table.name)
          .select("namespace")
          .distinct()
          .orderBy("namespace", "asc")
          .execute();

        return result.map((row) => row.namespace);
      },
    );

    /**
     * Update multiple configuration values in a transaction
     * @param {Array<{namespace: string, key: string, value: string | null, dataType: AppConfig.DataTypeT}>} configs - Array of configurations to update
     * @param {string | null} updatedBy - The ID of the user making the updates
     * @returns {Promise<AppConfig.EncodedT[]>} - The updated configurations
     */
    export const setMultiple = createServerOnlyFn(
      async (
        configs: Array<{
          namespace: string;
          key: string;
          displayName: string | null;
          value: string | null;
          dataType: AppConfig.DataTypeT;
        }>,
        updatedBy: string | null = null,
      ): Promise<AppConfig.EncodedT[]> => {
        return await db.transaction().execute(async (trx) => {
          const results: AppConfig.EncodedT[] = [];

          for (const config of configs) {
            const result = await trx
              .insertInto(AppConfig.Table.name)
              .values({
                namespace: config.namespace,
                key: config.key,
                display_name: config.displayName,
                value: config.value,
                data_type: config.dataType,
                last_modified_by: updatedBy,
                created_at: sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
              })
              .onConflict((oc) =>
                oc.columns(["namespace", "key"]).doUpdateSet({
                  value: (eb) => eb.ref("excluded.value"),
                  data_type: (eb) => eb.ref("excluded.data_type"),
                  last_modified_by: updatedBy,
                  updated_at: sql`now()::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                }),
              )
              .returningAll()
              .executeTakeFirstOrThrow();

            results.push(result);
          }

          return results;
        });
      },
    );
  }

  /**
   * Utility functions for working with typed configuration values
   */
  export namespace Utils {
    /**
     * Parse a configuration value based on its data type
     * @param {AppConfig.EncodedT} config - The configuration entry
     * @returns {any} - The parsed value
     */
    export const parseValue = (config: AppConfig.EncodedT): any => {
      if (config.value === null) return null;

      switch (config.data_type) {
        case "string":
          return String(config.value).replace(/"/g, "");
        case "number":
          return parseFloat(config.value);
        case "boolean":
          return config.value.toLowerCase() === "true";
        case "json":
          try {
            return JSON.parse(config.value);
          } catch {
            return null;
          }
        case "array":
          try {
            const parsed = JSON.parse(config.value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        default:
          return config.value;
      }
    };

    /**
     * Serialize a value for storage
     * @param {any} value - The value to serialize
     * @param {AppConfig.DataTypeT} dataType - The target data type
     * @returns {string | null} - The serialized value
     */
    export const serializeValue = (
      value: any,
      dataType: AppConfig.DataTypeT,
    ): string | null => {
      if (value === null || value === undefined) return null;

      switch (dataType) {
        case "string":
          return String(value);
        case "number":
          return String(value);
        case "boolean":
          return String(Boolean(value));
        case "json":
        case "array":
          return JSON.stringify(value);
        default:
          return String(value);
      }
    };

    /**
     * Given a Config object, and a key of interest, return the value or null
     * @param {AppConfig.EncodedT} config - The Config object
     * @param {AppConfig.NamespacesT} namespace - The namespace of interest
     * @param {string} key - The key of interest
     * @returns {T | null} - The value or null
     */
    export const getValue = <T>(
      config: AppConfig.EncodedT[],
      namespace: AppConfig.NamespacesT,
      key: string,
    ): T | null => {
      const item = config.find(
        (item) => item.namespace === namespace && item.key === key,
      );
      if (!item) return null;

      return parseValue(item);
    };

    /**
     * Whether a row's `clinic_ids` scope covers a given clinic.
     * null -> every clinic (also every row predating the column). [] -> none.
     *
     * INVERSE of `event_forms.clinic_ids`, where empty means "all".
     * Mirrors `app/utils/appConfigScope.ts` on mobile.
     */
    export const appliesToClinic = (
      clinicIds: readonly string[] | null,
      clinicId: string | null,
    ): boolean => {
      if (clinicIds === null) return true;
      return clinicId !== null && clinicIds.includes(clinicId);
    };
  }
}

export default AppConfig;
