import db from "@/db";
import {
  DatabaseError,
  executeQuery,
  executeQueryTakeFirst,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  type DomainError,
} from "@/db/helpers";
import { createServerOnlyFn } from "@tanstack/react-start";
import { flow, Option, pipe, Effect } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  type JSONColumnType,
  sql,
  Transaction,
} from "kysely";
import { isValidUUID, safeJSONParse, toSafeDateString } from "@/lib/utils";
import UserClinicPermissions from "./user-clinic-permissions";
import { v1 as uuidV1 } from "uuid";
import { Logger } from "@hikmahealth/js-utils";

const validateDrugId = (id: string): Effect.Effect<string, ValidationError> => {
  if (!id || id.length === 0) {
    return Effect.fail(new ValidationError("Drug ID cannot be empty"));
  }
  if (!isValidUUID(id)) {
    return Effect.fail(new ValidationError("Invalid UUID format"));
  }
  return Effect.succeed(id);
};

const validateMetadata = (
  metadata: unknown,
): Effect.Effect<Record<string, any>, ValidationError> => {
  if (metadata === null || metadata === undefined) {
    return Effect.succeed({});
  }
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return Effect.fail(new ValidationError("Metadata must be an object"));
  }
  return Effect.succeed(metadata as Record<string, any>);
};

const validateBarcode = (
  barcode: string,
): Effect.Effect<string, ValidationError> =>
  barcode && barcode.length > 0
    ? Effect.succeed(barcode)
    : Effect.fail(new ValidationError("Barcode cannot be empty"));

const validateSearchTerm = (
  term: string,
): Effect.Effect<string, ValidationError> =>
  term && term.length >= 2
    ? Effect.succeed(term)
    : Effect.fail(
        new ValidationError("Search term must be at least 2 characters"),
      );

const validatePagination = (params: {
  limit?: number;
  offset?: number;
}): Effect.Effect<{ limit: number; offset: number }, ValidationError> => {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  if (limit < 1 || limit > 1000) {
    return Effect.fail(new ValidationError("Limit must be between 1 and 1000"));
  }
  if (offset < 0) {
    return Effect.fail(new ValidationError("Offset must be non-negative"));
  }

  return Effect.succeed({ limit, offset });
};

namespace DrugCatalogue {
  export type Drug = Selectable<Table.T>;
  export type NewDrug = Insertable<Table.T>;
  export type DrugUpdate = Updateable<Table.T>;

  // API response type with nullable fields
  export type ApiDrug = {
    id: string;
    barcode: string | null;
    generic_name: string;
    brand_name: string | null;
    form: string;
    route: string;
    dosage_quantity: number;
    dosage_units: string;
    manufacturer: string | null;
    sale_price: number;
    sale_currency: string | null;
    min_stock_level: number | null;
    max_stock_level: number | null;
    is_controlled: boolean;
    requires_refrigeration: boolean;
    is_active: boolean;
    notes: string | null;
    recorded_by_user_id: string | null;
    metadata: Record<string, any>;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
    last_modified: Date;
    server_created_at: Date;
    deleted_at: Date | null;
  };

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = true;
    export const name = "drug_catalogue";
    /** The name of the table in the mobile database */
    export const mobileName = "drug_catalogue";
    export const columns = {
      id: "id",
      barcode: "barcode",
      generic_name: "generic_name",
      brand_name: "brand_name",
      form: "form",
      route: "route",
      dosage_quantity: "dosage_quantity",
      dosage_units: "dosage_units",
      manufacturer: "manufacturer",
      sale_price: "sale_price",
      sale_currency: "sale_currency",
      min_stock_level: "min_stock_level",
      max_stock_level: "max_stock_level",
      is_controlled: "is_controlled",
      requires_refrigeration: "requires_refrigeration",
      is_active: "is_active",
      notes: "notes",
      recorded_by_user_id: "recorded_by_user_id",
      metadata: "metadata",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
    };

    export interface T {
      id: string;
      barcode: string | null;
      generic_name: string;
      brand_name: string | null;
      form: string;
      route: string;
      dosage_quantity: ColumnType<number, string | number, string | number>;
      dosage_units: string;
      manufacturer: string | null;
      sale_price: ColumnType<
        number,
        string | number | undefined,
        string | number
      >;
      sale_currency: string | null;
      min_stock_level: Generated<number | null>;
      max_stock_level: number | null;
      is_controlled: Generated<boolean>;
      requires_refrigeration: Generated<boolean>;
      is_active: Generated<boolean>;
      notes: string | null;
      recorded_by_user_id: string | null;
      metadata: JSONColumnType<Record<string, any>>;
      is_deleted: Generated<boolean>;
      // Bare ColumnType, not Generated<ColumnType<…>>: the wrapper nests a
      // second time, leaving select as a ColumnType object and update as a
      // type no write can satisfy. The middle slot already covers insert.
      created_at: ColumnType<Date, string | undefined, never>;
      updated_at: ColumnType<Date, string | undefined, string | undefined>;
      // Writable, unlike created_at: sync keys its delta off this column.
      last_modified: ColumnType<Date, string | undefined, string | undefined>;
      server_created_at: ColumnType<Date, string | undefined, never>;
      deleted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
    }

    export type DrugCatalogue = Selectable<T>;
    export type NewDrugCatalogue = Insertable<T>;
    export type DrugCatalogueUpdate = Updateable<T>;
  }

  /**
   * Columns an administrator may write when editing a catalogue entry. Identity,
   * soft-delete state and the sync timestamps are server-owned and deliberately
   * absent. `metadata` is editable too, but applied separately: it needs JSON
   * serialization before it can reach a jsonb column.
   */
  const EDITABLE_COLUMNS = [
    "barcode",
    "generic_name",
    "brand_name",
    "form",
    "route",
    "dosage_quantity",
    "dosage_units",
    "manufacturer",
    "sale_price",
    "sale_currency",
    "min_stock_level",
    "max_stock_level",
    "is_controlled",
    "requires_refrigeration",
    "is_active",
    "notes",
    "recorded_by_user_id",
  ] as const satisfies readonly (keyof ApiDrug &
    keyof Table.DrugCatalogueUpdate)[];

  export type DrugUpdatePatch = Pick<
    Table.DrugCatalogueUpdate,
    (typeof EDITABLE_COLUMNS)[number] | "metadata"
  >;

  /**
   * Narrow a caller's payload to the columns an edit may write.
   *
   * An absent key leaves the stored value alone, unlike `buildUpsertValues`,
   * which substitutes a default for every missing column and so blanks anything
   * a partial payload omits. An explicit `null` is a value here — clearing a
   * barcode or a note is a legitimate edit.
   */
  export const buildUpdateValues = (
    drug: Partial<ApiDrug>,
  ): DrugUpdatePatch => {
    const patch: DrugUpdatePatch = {};
    for (const column of EDITABLE_COLUMNS) {
      if (drug[column] === undefined) continue;
      (patch as Record<string, unknown>)[column] = drug[column];
    }
    if (drug.metadata !== undefined) {
      patch.metadata = JSON.stringify(drug.metadata);
    }
    return patch;
  };

  // ============ QUERY BUILDERS ============

  const baseQuery = () =>
    db.selectFrom(Table.name).where("is_deleted", "=", false);

  const withActiveFilter =
    (isActive: boolean) =>
    <QB extends { where: any }>(query: QB) =>
      query.where("is_active", "=", isActive);

  const withPagination =
    ({ limit = 50, offset = 0 }: { limit?: number; offset?: number }) =>
    <QB extends { limit: any; offset: any }>(query: QB) =>
      query.limit(limit).offset(offset);

  const withOrdering =
    (column: string, order: "asc" | "desc" = "asc") =>
    <QB extends { orderBy: any }>(query: QB) =>
      query.orderBy(column, order);

  const buildSearchCondition = (searchTerm: string) => {
    const pattern = `%${searchTerm}%`;
    return (eb: any) =>
      eb.or([
        eb("generic_name", "ilike", pattern),
        eb("brand_name", "ilike", pattern),
        eb("barcode", "ilike", pattern),
        eb("manufacturer", "ilike", pattern),
      ]);
  };

  // ============ PERMISSION CHECKING (Effect-based) ============

  // TODO: default to checking if the user is an admin or is super admin
  const checkInventoryPermission = Effect.tryPromise({
    try: () =>
      UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
        "is_clinic_admin",
      ),
    catch: (error) => new DatabaseError("Failed to check permissions", error),
  }).pipe(
    Effect.flatMap((clinicIds) =>
      clinicIds.length > 0
        ? Effect.succeed(clinicIds)
        : Effect.fail(
            new UnauthorizedError("No inventory management permissions"),
          ),
    ),
  );

  export namespace API {
    export const getById = createServerOnlyFn(
      (id: string): Effect.Effect<ApiDrug | undefined, DomainError> =>
        pipe(
          validateDrugId(id),
          Effect.flatMap((validId) =>
            executeQueryTakeFirst(
              baseQuery().selectAll().where("id", "=", validId),
            ),
          ),
          Effect.map((result) => result as ApiDrug | undefined),
        ),
    );

    export const getByBarcode = createServerOnlyFn(
      (barcode: string): Effect.Effect<ApiDrug | undefined, DomainError> =>
        pipe(
          validateBarcode(barcode),
          Effect.flatMap((validBarcode) =>
            executeQueryTakeFirst(
              baseQuery().selectAll().where("barcode", "=", validBarcode),
            ),
          ),
          Effect.map((result) => result as ApiDrug | undefined),
        ),
    );

    export const getAll = createServerOnlyFn(
      (
        params: {
          limit?: number;
          offset?: number;
          isActive?: boolean;
        } = {},
      ): Effect.Effect<ApiDrug[], DomainError> =>
        pipe(
          validatePagination(params),
          Effect.flatMap(({ limit, offset }) => {
            const query = flow(
              () => baseQuery().selectAll(),
              params.isActive !== undefined
                ? withActiveFilter(params.isActive)
                : (x: any) => x,
              withOrdering("generic_name"),
              withPagination({ limit, offset }),
            )();

            return executeQuery(query);
          }),
          Effect.map((results) => results as ApiDrug[]),
        ),
    );

    export const search = createServerOnlyFn(
      (params: {
        searchTerm: string;
        limit?: number;
        offset?: number;
      }): Effect.Effect<ApiDrug[], DomainError> =>
        pipe(
          Effect.all({
            searchTerm: validateSearchTerm(params.searchTerm),
            pagination: validatePagination({
              limit: params.limit,
              offset: params.offset,
            }),
          }),
          Effect.flatMap(({ searchTerm, pagination }) => {
            const { limit, offset } = pagination;
            const query = flow(
              () => baseQuery().selectAll(),
              (q) => q.where(buildSearchCondition(searchTerm)),
              withOrdering("generic_name"),
              withPagination({ limit, offset }),
            )();

            return executeQuery(query);
          }),
          Effect.map((results) => results as ApiDrug[]),
        ),
    );

    const buildUpsertValues = (drug: Partial<ApiDrug>, id: string) => ({
      id,
      barcode: drug.barcode ?? null,
      generic_name: drug.generic_name || "",
      brand_name: drug.brand_name ?? null,
      form: drug.form || "",
      route: drug.route || "",
      dosage_quantity: drug.dosage_quantity || 0,
      dosage_units: drug.dosage_units || "",
      manufacturer: drug.manufacturer ?? null,
      sale_price: drug.sale_price || 0,
      sale_currency: drug.sale_currency ?? null,
      min_stock_level: drug.min_stock_level ?? 0,
      max_stock_level: drug.max_stock_level ?? null,
      is_controlled: drug.is_controlled ?? false,
      requires_refrigeration: drug.requires_refrigeration ?? false,
      is_active: drug.is_active ?? true,
      notes: drug.notes ?? null,
      recorded_by_user_id: drug.recorded_by_user_id ?? null,
      metadata: drug.metadata ? JSON.stringify(drug.metadata) : "{}",
      is_deleted: drug.is_deleted ?? false,
    });

    const executeCoreUpsert = (
      drug: Partial<ApiDrug>,
      trx: Transaction<any>,
    ): Effect.Effect<{ id: string }, DatabaseError> => {
      const id = drug.id || uuidV1();
      const values = buildUpsertValues(drug, id);

      // executeQueryTakeFirst returns undefined when the WHERE guard skips a stale record
      return pipe(
        executeQueryTakeFirst(
          trx
            .insertInto(Table.name)
            .values({
              ...values,
              metadata: sql`${JSON.stringify(
                safeJSONParse(values.metadata, {}),
              )}::jsonb`,
              created_at: drug.created_at
                ? sql`${toSafeDateString(drug.created_at)}::timestamp with time zone`
                : sql`now()::timestamp with time zone`,
              updated_at: drug.updated_at
                ? sql`${toSafeDateString(drug.updated_at)}::timestamp with time zone`
                : sql`now()::timestamp with time zone`,
              last_modified: sql`now()::timestamp with time zone`,
              server_created_at: sql`now()::timestamp with time zone`,
              deleted_at: drug.deleted_at
                ? sql`${toSafeDateString(drug.deleted_at)}::timestamp with time zone`
                : null,
            })
            .onConflict((oc) =>
              oc
                .column("id")
                .doUpdateSet((eb) => ({
                  barcode: eb.ref("excluded.barcode"),
                  generic_name: eb.ref("excluded.generic_name"),
                  brand_name: eb.ref("excluded.brand_name"),
                  form: eb.ref("excluded.form"),
                  route: eb.ref("excluded.route"),
                  dosage_quantity: eb.ref("excluded.dosage_quantity"),
                  dosage_units: eb.ref("excluded.dosage_units"),
                  manufacturer: eb.ref("excluded.manufacturer"),
                  sale_price: eb.ref("excluded.sale_price"),
                  sale_currency: eb.ref("excluded.sale_currency"),
                  min_stock_level: eb.ref("excluded.min_stock_level"),
                  max_stock_level: eb.ref("excluded.max_stock_level"),
                  is_controlled: eb.ref("excluded.is_controlled"),
                  requires_refrigeration: eb.ref(
                    "excluded.requires_refrigeration",
                  ),
                  is_active: eb.ref("excluded.is_active"),
                  notes: eb.ref("excluded.notes"),
                  recorded_by_user_id: eb.ref("excluded.recorded_by_user_id"),
                  metadata: eb.ref("excluded.metadata"),
                  is_deleted: eb.ref("excluded.is_deleted"),
                  updated_at: sql`now()::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                  deleted_at: drug.deleted_at
                    ? sql`${toSafeDateString(drug.deleted_at)}::timestamp with time zone`
                    : eb.ref("excluded.deleted_at"),
                }))
                // Only update if the incoming record is newer than what's already stored
                .where(
                  sql<boolean>`excluded.updated_at > drug_catalogue.updated_at`,
                ),
            )
            .returning("id"),
        ),
        Effect.map((result) => {
          if (!result) {
            Logger.info(`[sync] Skipped stale upsert for drug_catalogue ${id}`);
          }
          return result ?? { id };
        }),
      );
    };

    const withTransaction = <T>(
      effect: (trx: Transaction<any>) => Effect.Effect<T, DomainError>,
    ): Effect.Effect<T, DomainError> =>
      Effect.tryPromise({
        try: () =>
          db.transaction().execute(async (trx) => {
            const result = await Effect.runPromise(effect(trx));
            return result;
          }),
        catch: (error) => new DatabaseError("Transaction failed", error),
      });

    export const upsert = createServerOnlyFn(
      (drug: Partial<ApiDrug>): Effect.Effect<{ id: string }, DomainError> =>
        pipe(
          checkInventoryPermission,
          Effect.flatMap(() =>
            withTransaction((trx) => executeCoreUpsert(drug, trx)),
          ),
        ),
    );

    export const DANGEROUS_SYNC_ONLY_upsert = createServerOnlyFn(
      (drug: Partial<ApiDrug>): Effect.Effect<{ id: string }, DomainError> =>
        withTransaction((trx) => executeCoreUpsert(drug, trx)),
    );

    /**
     * Apply an administrator's edit to an existing catalogue entry.
     *
     * Separate from `upsert` rather than another caller of it: that path absorbs
     * records arriving from sync, so it resets every column the payload omits
     * and — through the `excluded.updated_at >` conflict guard — silently drops
     * any write not newer than the stored row, which is exactly what an edit
     * replaying the row it just loaded is.
     *
     * Fails with NotFoundError when no live row has this id; a soft-deleted
     * entry is not editable until it is restored.
     */
    export const update = createServerOnlyFn(
      (
        id: string,
        drug: Partial<ApiDrug>,
      ): Effect.Effect<{ id: string }, DomainError> =>
        pipe(
          checkInventoryPermission,
          Effect.flatMap(() => validateDrugId(id)),
          Effect.flatMap((validId) =>
            Effect.map(
              drug.metadata === undefined
                ? Effect.succeed({})
                : validateMetadata(drug.metadata),
              () => validId,
            ),
          ),
          Effect.flatMap((validId) => {
            const { metadata, ...columns } = buildUpdateValues(drug);
            return executeQueryTakeFirst(
              db
                .updateTable(Table.name)
                .set({
                  ...columns,
                  ...(metadata === undefined
                    ? {}
                    : { metadata: sql<string>`${metadata}::jsonb` }),
                  updated_at: sql`now()::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                })
                .where("id", "=", validId)
                .where("is_deleted", "=", false)
                .returning("id"),
            );
          }),
          Effect.flatMap((result) =>
            result
              ? Effect.succeed(result as { id: string })
              : Effect.fail(new NotFoundError(`Drug with ID ${id} not found`)),
          ),
        ),
    );

    const executeCoreSoftDelete = (
      id: string,
      trx?: Transaction<any>,
    ): Effect.Effect<void, DomainError> =>
      pipe(
        validateDrugId(id),
        Effect.flatMap((validId) => {
          const query = (trx || db)
            .updateTable(Table.name)
            .set({
              is_deleted: true,
              deleted_at: sql`now()::timestamp with time zone`,
              updated_at: sql`now()::timestamp with time zone`,
              last_modified: sql`now()::timestamp with time zone`,
            })
            .where("id", "=", validId);

          return executeQueryTakeFirst(query);
        }),
        Effect.flatMap((result) =>
          result && result.numUpdatedRows && result.numUpdatedRows > 0n
            ? Effect.void
            : Effect.fail(new NotFoundError(`Drug with ID ${id} not found`)),
        ),
      );

    export const softDelete = createServerOnlyFn(
      (id: string): Effect.Effect<void, DomainError> =>
        pipe(
          checkInventoryPermission,
          Effect.flatMap(() => executeCoreSoftDelete(id)),
        ),
    );

    export const DANGEROUS_SYNC_ONLY_softDelete = createServerOnlyFn(
      (id: string): Effect.Effect<void, DomainError> =>
        executeCoreSoftDelete(id),
    );

    export const batchGetByIds = createServerOnlyFn(
      (ids: string[]): Effect.Effect<ApiDrug[], DomainError> =>
        pipe(
          Effect.all(ids.map(validateDrugId)),
          Effect.flatMap((validIds) =>
            validIds.length === 0
              ? Effect.succeed([])
              : executeQuery(
                  baseQuery()
                    .selectAll()
                    .where("id", "in", validIds)
                    .orderBy("generic_name", "asc"),
                ),
          ),
          Effect.map((results) => results as ApiDrug[]),
        ),
    );

    // ============ AGGREGATION QUERIES ============

    export const getStats = createServerOnlyFn(
      (): Effect.Effect<
        {
          totalDrugs: number;
          activeDrugs: number;
          controlledDrugs: number;
          refrigeratedDrugs: number;
        },
        DomainError
      > =>
        pipe(
          Effect.all({
            total: executeQueryTakeFirst(
              db
                .selectFrom(Table.name)
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("is_deleted", "=", false),
            ),
            active: executeQueryTakeFirst(
              db
                .selectFrom(Table.name)
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("is_deleted", "=", false)
                .where("is_active", "=", true),
            ),
            controlled: executeQueryTakeFirst(
              db
                .selectFrom(Table.name)
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("is_deleted", "=", false)
                .where("is_controlled", "=", true),
            ),
            refrigerated: executeQueryTakeFirst(
              db
                .selectFrom(Table.name)
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .where("is_deleted", "=", false)
                .where("requires_refrigeration", "=", true),
            ),
          }),
          Effect.map(({ total, active, controlled, refrigerated }) => ({
            totalDrugs: total?.count || 0,
            activeDrugs: active?.count || 0,
            controlledDrugs: controlled?.count || 0,
            refrigeratedDrugs: refrigerated?.count || 0,
          })),
        ),
    );
  }

  export namespace Sync {
    export const upsertFromDelta = createServerOnlyFn(
      (delta: ApiDrug): Effect.Effect<{ id: string }, DomainError> =>
        API.DANGEROUS_SYNC_ONLY_upsert(delta),
    );

    export const deleteFromDelta = createServerOnlyFn(
      (id: string): Effect.Effect<void, DomainError> =>
        API.DANGEROUS_SYNC_ONLY_softDelete(id),
    );
  }
}

export default DrugCatalogue;
