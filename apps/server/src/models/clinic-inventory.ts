import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import { Option } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  type JSONColumnType,
  sql,
} from "kysely";
import { safeJSONParse, toSafeDateString } from "@/lib/utils";
import UserClinicPermissions from "./user-clinic-permissions";
import InventoryTransactions from "./inventory-transactions";
import { v1 as uuidV1 } from "uuid";

namespace ClinicInventory {
  export type T = {
    id: string;
    clinic_id: string;
    drug_id: string;
    batch_id: string;
    quantity_available: number;
    reserved_quantity: number;
    last_counted_at: Option.Option<Date>;
    recorded_by_user_id: Option.Option<string>;
    metadata: Record<string, any>;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
    last_modified: Date;
    server_created_at: Date;
    deleted_at: Option.Option<Date>;

    batch_number: string;
    batch_expiry_date: Date;
  };

  export type EncodedT = {
    id: string;
    clinic_id: string;
    drug_id: string;
    batch_id: string;
    quantity_available: number;
    reserved_quantity: number;
    last_counted_at: Date | null;
    recorded_by_user_id: string | null;
    metadata: Record<string, any>;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
    last_modified: Date;
    server_created_at: Date;
    deleted_at: Date | null;

    batch_number: string;
    batch_expiry_date: Date;
  };

  /**
   * Type definition for drug inventory item with batch information
   */
  export type DrugWithBatchInfo = {
    drug_id: string;
    generic_name: string;
    brand_name: string | null;
    form: string | null;
    route: string | null;
    // decimal(10, 4) — pg hands it back as a string; format it with
    // `formatDrugStrength` rather than rounding to a fixed width.
    dosage_quantity: string | null;
    dosage_units: string | null;
    sale_price: number | null;
    sale_currency: string | null;
    is_controlled: boolean;
    requires_refrigeration: boolean;
    batch_expiry_date: Date | null;
    quantity: number;
    reserved_quantity: number;
    /**
     * What a removal would write off, floored per row before summing — the
     * same expression `getClinicDrugStock` reports and `planRowRemoval` acts
     * on. Not `quantity - reserved_quantity`: a row gone negative through
     * reconciliation contributes 0 rather than eating another batch's stock.
     */
    destroyable_quantity: number;
    batches: {
      batch_id: string;
      batch_expiry_date: Date | null;
      quantity: number;
    }[];
  };

  /**
   * Stock held for one drug at one clinic, summed across every batch.
   *
   * `reserved_quantity` is carved out of `quantity_available`.
   * `destroyable_quantity` is summed per batch rather than derived from those
   * two totals, so a row gone negative through reconciliation contributes 0.
   */
  export type ClinicDrugStock = {
    batch_count: number;
    quantity_available: number;
    reserved_quantity: number;
    destroyable_quantity: number;
  };

  /** What `removeDrugFromClinic` actually did, in units and batch rows. */
  export type DrugRemovalOutcome = {
    batches_cleared: number;
    batches_retained: number;
    units_destroyed: number;
    units_retained: number;
  };

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     * This table is server-only and synced down to clients for read-only access.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = true;
    export const name = "clinic_inventory";
    /** The name of the table in the mobile database */
    export const mobileName = "clinic_inventory";
    export const columns = {
      id: "id",
      clinic_id: "clinic_id",
      drug_id: "drug_id",
      batch_id: "batch_id",
      quantity_available: "quantity_available",
      reserved_quantity: "reserved_quantity",
      last_counted_at: "last_counted_at",
      recorded_by_user_id: "recorded_by_user_id",
      metadata: "metadata",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",

      batch_number: "batch_number",
      batch_expiry_date: "batch_expiry_date",
    };

    export interface T {
      id: string;
      clinic_id: string;
      drug_id: string;
      batch_id: string;
      quantity_available: number;
      reserved_quantity: Generated<number>;
      last_counted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      recorded_by_user_id: string | null;
      metadata: JSONColumnType<Record<string, any>>;
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

      batch_number: string;
      batch_expiry_date: Date;
    }

    export type ClinicInventory = Selectable<T>;
    export type NewClinicInventory = Insertable<T>;
    export type ClinicInventoryUpdate = Updateable<T>;
  }

  export namespace API {
    export const getById = createServerOnlyFn(
      async (id: string): Promise<EncodedT | undefined> => {
        return (await db
          .selectFrom(Table.name)
          .selectAll()
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .executeTakeFirst()) as Promise<EncodedT | undefined>;
      },
    );

    export const getByClinicAndDrug = createServerOnlyFn(
      async (
        clinicId: string,
        drugId: string,
        batchId?: string,
      ): Promise<EncodedT | undefined> => {
        let query = db
          .selectFrom(Table.name)
          .selectAll()
          .where("clinic_id", "=", clinicId)
          .where("drug_id", "=", drugId)
          .where("is_deleted", "=", false);

        if (batchId) {
          query = query.where("batch_id", "=", batchId);
        }

        return (await query.executeTakeFirst()) as Promise<
          EncodedT | undefined
        >;
      },
    );

    export const getByClinic = createServerOnlyFn(
      async (
        clinicId: string,
        {
          limit = 50,
          offset = 0,
          includeZeroStock = false,
        }: {
          limit?: number;
          offset?: number;
          includeZeroStock?: boolean;
        } = {},
      ): Promise<EncodedT[]> => {
        let query = db
          .selectFrom(Table.name)
          .selectAll()
          .where("clinic_id", "=", clinicId)
          .where("is_deleted", "=", false);

        if (!includeZeroStock) {
          query = query.where("quantity_available", ">", 0);
        }

        const results = await query
          .orderBy("drug_id", "asc")
          .limit(limit)
          .offset(offset)
          .execute();

        return results as EncodedT[];
      },
    );

    /**
     * The drugs a clinic stocks. Backs both the list and its count, so the two
     * cannot disagree about what is on the shelves.
     */
    const drugsStockedAtClinic = (
      clinicId: string,
      searchQuery?: string,
      includeZeroStock = true,
    ) => {
      let query = db
        .selectFrom("drug_catalogue as dc")
        .where("dc.is_deleted", "=", false)
        .where("dc.is_active", "=", true)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("clinic_inventory as ci")
              .select("ci.id")
              .whereRef("ci.drug_id", "=", "dc.id")
              .where("ci.clinic_id", "=", clinicId)
              .where("ci.is_deleted", "=", false)
              .$if(!includeZeroStock, (qb) =>
                qb.where("ci.quantity_available", ">", 0),
              ),
          ),
        );

      if (searchQuery && searchQuery.trim()) {
        const searchPattern = `%${searchQuery.trim()}%`;
        query = query.where((eb) =>
          eb.or([
            eb("dc.generic_name", "ilike", searchPattern),
            eb("dc.brand_name", "ilike", searchPattern),
          ]),
        );
      }

      return query;
    };

    /**
     * How many distinct drugs the clinic stocks, under the same filter
     * `getWithDrugInfo` lists. A total across pages, not a page size.
     */
    export const countStockedDrugs = createServerOnlyFn(
      async (
        clinicId: string,
        searchQuery?: string,
        { includeZeroStock = true }: { includeZeroStock?: boolean } = {},
      ): Promise<number> => {
        const row = await drugsStockedAtClinic(
          clinicId,
          searchQuery,
          includeZeroStock,
        )
          .select(sql<number>`COUNT(*)::int`.as("total"))
          .executeTakeFirst();

        return row?.total ?? 0;
      },
    );

    /**
     * Get inventory items with drug information
     * @param clinicId - The ID of the clinic to retrieve inventory for
     * @param searchQuery - Optional search query to filter drugs by generic_name or brand_name
     * @param options - Query options
     * @param options.limit - Maximum number of items to return (default: 50)
     * @param options.offset - Number of items to skip for pagination (default: 0)
     * @param options.includeZeroStock - Whether to include items with zero quantity (default: false)
     * @returns Array of inventory items grouped by drug with batch information
     */
    export const getWithDrugInfo = createServerOnlyFn(
      async (
        clinicId: string,
        searchQuery?: string,
        {
          limit = 50,
          offset = 0,
          includeZeroStock = true,
        }: {
          limit?: number;
          offset?: number;
          includeZeroStock?: boolean;
        } = {},
      ): Promise<DrugWithBatchInfo[]> => {
        // Single query to get drugs with their batches using JSON aggregation
        const results = await drugsStockedAtClinic(
          clinicId,
          searchQuery,
          includeZeroStock,
        )
          .select([
            "dc.id as drug_id",
            "dc.generic_name",
            "dc.brand_name",
            "dc.form",
            "dc.route",
            "dc.dosage_quantity",
            "dc.dosage_units",
            sql<number | null>`dc.sale_price`.as("sale_price"),
            "dc.sale_currency",
            "dc.is_controlled",
            "dc.requires_refrigeration",
            // Get the first batch info (for compatibility with existing code that expects batch_id and batch_expiry_date)
            // sql<string>`(
            //   SELECT ci.batch_id
            //   FROM clinic_inventory ci
            //   WHERE ci.clinic_id = ${clinicId}
            //     AND ci.drug_id = dc.id
            //     AND ci.is_deleted = false
            //     ${!includeZeroStock ? sql`AND ci.quantity_available > 0` : sql``}
            //   ORDER BY ci.quantity_available DESC
            //   LIMIT 1
            // )`.as("batch_id"),
            sql<Date | null>`(
              SELECT db.expiry_date
              FROM clinic_inventory ci
              LEFT JOIN drug_batches db ON ci.batch_id = db.id
              WHERE ci.clinic_id = ${clinicId}
                AND ci.drug_id = dc.id
                AND ci.is_deleted = false
                ${!includeZeroStock ? sql`AND ci.quantity_available > 0` : sql``}
              ORDER BY ci.quantity_available DESC
              LIMIT 1
            )`.as("batch_expiry_date"),
            // Calculate total quantity. SUM(integer) is bigint, which pg
            // returns as a string; the cast keeps the declared `number` honest.
            sql<number>`(
              SELECT COALESCE(SUM(ci.quantity_available), 0)::int
              FROM clinic_inventory ci
              WHERE ci.clinic_id = ${clinicId}
                AND ci.drug_id = dc.id
                AND ci.is_deleted = false
                ${!includeZeroStock ? sql`AND ci.quantity_available > 0` : sql``}
            )`.as("quantity"),
            // Calculate total quantity reserved. Carved out of the total
            // above, not additional to it.
            sql<number>`(
              SELECT COALESCE(SUM(ci.reserved_quantity), 0)::int
              FROM clinic_inventory ci
              WHERE ci.clinic_id = ${clinicId}
                AND ci.drug_id = dc.id
                AND ci.is_deleted = false
                AND ci.reserved_quantity > 0
            )`.as("reserved_quantity"),
            // Free stock, floored per row so a negative balance contributes 0.
            sql<number>`(
              SELECT COALESCE(SUM(GREATEST(ci.quantity_available - GREATEST(ci.reserved_quantity, 0), 0)), 0)::int
              FROM clinic_inventory ci
              WHERE ci.clinic_id = ${clinicId}
                AND ci.drug_id = dc.id
                AND ci.is_deleted = false
                ${!includeZeroStock ? sql`AND ci.quantity_available > 0` : sql``}
            )`.as("destroyable_quantity"),
            // Get all batches as JSON array
            sql<
              {
                batch_id: string;
                batch_expiry_date: Date | null;
                quantity: number;
              }[]
            >`(
              SELECT COALESCE(
                JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'batch_id', ci.batch_id,
                    'batch_expiry_date', db.expiry_date,
                    'quantity', ci.quantity_available
                  )
                  ORDER BY db.expiry_date ASC NULLS LAST, ci.quantity_available DESC
                ),
                '[]'::json
              )
              FROM clinic_inventory ci
              LEFT JOIN drug_batches db ON ci.batch_id = db.id
              WHERE ci.clinic_id = ${clinicId}
                AND ci.drug_id = dc.id
                AND ci.is_deleted = false
                ${!includeZeroStock ? sql`AND ci.quantity_available > 0` : sql``}
            )`.as("batches"),
          ])
          .orderBy("dc.generic_name", "asc")
          .limit(limit)
          .offset(offset)
          .execute();

        return results as DrugWithBatchInfo[];
      },
    );

    /**
     * Update inventory quantity - this is a server-only operation
     * Use this for receiving stock, dispensing, adjustments, etc.
     */
    export const updateQuantity = createServerOnlyFn(
      async ({
        clinicId,
        drugId,
        batchId,
        batchNumber,
        batchExpiryDate,
        quantityChange,
        transactionType,
        referenceId,
        reason,
        performedBy,
        reserveQuantity,
      }: {
        clinicId: string;
        drugId: string;
        batchId: string;
        batchNumber: string;
        batchExpiryDate: Date;
        quantityChange: number; // Positive for additions, negative for reductions
        transactionType: string; // received, dispensed, transferred_in, transferred_out, expired, damaged, adjustment, returned
        referenceId?: string;
        reason?: string;
        performedBy?: string;
        reserveQuantity?: number; // Optional: update reserved quantity
      }): Promise<any> => {
        // Permissions check
        const clinicIds =
          await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
            "is_clinic_admin",
          );

        if (!clinicIds.includes(clinicId)) {
          throw new Error(
            "Unauthorized: No inventory management permissions for this clinic",
          );
        }

        return await db.transaction().execute(async (trx) => {
          // Get current inventory or create if doesn't exist
          // The (clinic, drug, batch) unique index spans soft-deleted rows, so
          // a removed row is revived rather than inserted a second time.
          const currentInventory = await trx
            .selectFrom(Table.name)
            .selectAll()
            .where("clinic_id", "=", clinicId)
            .where("drug_id", "=", drugId)
            .where("batch_id", "=", batchId)
            .executeTakeFirst();

          let newQuantity: number;
          let inventoryId: string;

          if (currentInventory) {
            // A revived row restarts from zero; its old balance was written off.
            const openingQuantity = currentInventory.is_deleted
              ? 0
              : currentInventory.quantity_available;
            newQuantity = openingQuantity + quantityChange;
            inventoryId = currentInventory.id;

            // Update existing inventory
            await trx
              .updateTable(Table.name)
              .set({
                quantity_available: newQuantity,
                reserved_quantity:
                  reserveQuantity ?? currentInventory.reserved_quantity,
                is_deleted: false,
                deleted_at: null,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
                last_counted_at:
                  transactionType === "adjustment"
                    ? sql`now()::timestamp with time zone`
                    : currentInventory.last_counted_at,
              })
              .where("id", "=", inventoryId)
              .execute();
          } else {
            // Create new inventory entry
            newQuantity = quantityChange;
            inventoryId = uuidV1();

            await trx
              .insertInto(Table.name)
              .values({
                id: inventoryId,
                clinic_id: clinicId,
                drug_id: drugId,
                batch_id: batchId,
                quantity_available: newQuantity,
                reserved_quantity: reserveQuantity ?? 0,
                last_counted_at:
                  transactionType === "adjustment"
                    ? sql`now()::timestamp with time zone`
                    : null,
                recorded_by_user_id: performedBy || null,
                metadata: sql`'{}'::jsonb`,
                is_deleted: false,
                created_at: sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
                server_created_at: sql`now()::timestamp with time zone`,
                deleted_at: null,

                batch_number: batchNumber,
                batch_expiry_date: batchExpiryDate,
              })
              .execute();
          }

          // Record the transaction
          // TODO: move this to the inventory_transactions model
          await trx
            .insertInto("inventory_transactions")
            .values({
              id: uuidV1(),
              clinic_id: clinicId,
              drug_id: drugId,
              batch_id: batchId,
              transaction_type: transactionType,
              quantity: quantityChange,
              balance_after: newQuantity,
              reference_type:
                transactionType === "dispensed"
                  ? "dispensing_record"
                  : transactionType === "adjustment"
                    ? "adjustment_record"
                    : null,
              reference_id: referenceId || null,
              reason: reason || null,
              performed_by: performedBy || null,
              timestamp: sql`now()::timestamp with time zone`,
              created_at: sql`now()::timestamp with time zone`,
              updated_at: sql`now()::timestamp with time zone`,
            })
            .execute();

          return { inventoryId, newQuantity };
        });
      },
    );

    /**
     * Reserve quantity for pending prescriptions
     */
    export const reserveQuantity = createServerOnlyFn(
      async ({
        clinicId,
        drugId,
        batchId,
        quantityToReserve,
      }: {
        clinicId: string;
        drugId: string;
        batchId: string;
        quantityToReserve: number;
      }): Promise<void> => {
        const inventory = await getByClinicAndDrug(clinicId, drugId, batchId);

        if (!inventory) {
          throw new Error("Inventory item not found");
        }

        if (inventory.quantity_available < quantityToReserve) {
          throw new Error("Insufficient stock to reserve");
        }

        await db
          .updateTable(Table.name)
          .set({
            reserved_quantity: inventory.reserved_quantity + quantityToReserve,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
          })
          .where("id", "=", inventory.id)
          .execute();
      },
    );

    /**
     * Release reserved quantity (e.g., when prescription is cancelled)
     */
    export const releaseReservedQuantity = createServerOnlyFn(
      async ({
        clinicId,
        drugId,
        batchId,
        quantityToRelease,
      }: {
        clinicId: string;
        drugId: string;
        batchId: string;
        quantityToRelease: number;
      }): Promise<void> => {
        const inventory = await getByClinicAndDrug(clinicId, drugId, batchId);

        if (!inventory) {
          throw new Error("Inventory item not found");
        }

        const newReservedQuantity = Math.max(
          0,
          inventory.reserved_quantity - quantityToRelease,
        );

        await db
          .updateTable(Table.name)
          .set({
            reserved_quantity: newReservedQuantity,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
          })
          .where("id", "=", inventory.id)
          .execute();
      },
    );

    export const softDelete = createServerOnlyFn(async (id: string) => {
      // Permissions check
      const clinicIds =
        await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
          "is_clinic_admin",
        );

      const inventory = await getById(id);
      if (!inventory) {
        throw new Error("Inventory item not found");
      }

      if (!clinicIds.includes(inventory.clinic_id)) {
        throw new Error(
          "Unauthorized: No inventory management permissions for this clinic",
        );
      }

      await db
        .updateTable(Table.name)
        .set({
          is_deleted: true,
          deleted_at: sql`now()::timestamp with time zone`,
          updated_at: sql`now()::timestamp with time zone`,
          last_modified: sql`now()::timestamp with time zone`,
        })
        .where("id", "=", id)
        .execute();
    });

    /**
     * Stock held for one drug at one clinic, summed across its batches.
     *
     * Clinic-scoped, unlike `drug_batches.quantity_remaining`, which counts a
     * batch across every clinic holding it.
     */
    export const getClinicDrugStock = createServerOnlyFn(
      async (clinicId: string, drugId: string): Promise<ClinicDrugStock> => {
        const totals = await db
          .selectFrom(Table.name)
          .select([
            sql<number>`COUNT(*)::int`.as("batch_count"),
            sql<number>`COALESCE(SUM(quantity_available), 0)::int`.as(
              "quantity_available",
            ),
            sql<number>`COALESCE(SUM(GREATEST(reserved_quantity, 0)), 0)::int`.as(
              "reserved_quantity",
            ),
            sql<number>`COALESCE(SUM(GREATEST(quantity_available - GREATEST(reserved_quantity, 0), 0)), 0)::int`.as(
              "destroyable_quantity",
            ),
          ])
          .where("clinic_id", "=", clinicId)
          .where("drug_id", "=", drugId)
          .where("is_deleted", "=", false)
          .executeTakeFirst();

        return {
          batch_count: totals?.batch_count ?? 0,
          quantity_available: totals?.quantity_available ?? 0,
          reserved_quantity: totals?.reserved_quantity ?? 0,
          destroyable_quantity: totals?.destroyable_quantity ?? 0,
        };
      },
    );

    const planRowRemoval = (row: {
      quantity_available: number;
      reserved_quantity: number | null;
    }) => {
      const retained = Math.max(0, row.reserved_quantity ?? 0);
      // A negative balance means dispensing outran receiving: nothing to write
      // off, and the row keeps that balance so its transaction still adds up.
      const destroyed = Math.max(0, row.quantity_available - retained);
      const newAvailable = Math.min(row.quantity_available, retained);
      return { retained, destroyed, newAvailable, keepRow: retained > 0 };
    };

    /**
     * Write a drug's stock off at one clinic and take it off its shelves.
     *
     * Rows holding units reserved for in-flight prescriptions keep those units
     * and stay live; the rest are soft-deleted, so mobile drops them on the
     * next sync. Dispensing history, the drug catalogue and other clinics are
     * untouched. Removing a drug that holds no stock is a no-op, not an error.
     */
    export const removeDrugFromClinic = createServerOnlyFn(
      async ({
        clinicId,
        drugId,
        performedBy,
        reason,
      }: {
        clinicId: string;
        drugId: string;
        performedBy: string | null;
        reason?: string;
      }): Promise<DrugRemovalOutcome> => {
        const clinicIds =
          await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
            "is_clinic_admin",
          );

        if (!clinicIds.includes(clinicId)) {
          throw new Error(
            "Unauthorized: No inventory management permissions for this clinic",
          );
        }

        return await db.transaction().execute(async (trx) => {
          const rows = await trx
            .selectFrom(Table.name)
            .selectAll()
            .where("clinic_id", "=", clinicId)
            .where("drug_id", "=", drugId)
            .where("is_deleted", "=", false)
            .forUpdate()
            .execute();

          for (const row of rows) {
            const plan = planRowRemoval(row);

            await trx
              .updateTable(Table.name)
              .set({
                quantity_available: plan.newAvailable,
                is_deleted: !plan.keepRow,
                deleted_at: plan.keepRow
                  ? null
                  : sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
              })
              .where("id", "=", row.id)
              .execute();

            await trx
              .insertInto("inventory_transactions")
              .values({
                id: uuidV1(),
                clinic_id: clinicId,
                drug_id: drugId,
                batch_id: row.batch_id,
                transaction_type:
                  InventoryTransactions.TransactionTypes.ADJUSTMENT,
                quantity: -plan.destroyed,
                balance_after: plan.newAvailable,
                reference_type:
                  InventoryTransactions.ReferenceTypes.ADJUSTMENT_RECORD,
                reference_id: null,
                reason:
                  reason ||
                  `Drug removed from clinic - Batch #${row.batch_number}`,
                performed_by: performedBy,
                timestamp: sql`now()::timestamp with time zone`,
                created_at: sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
              })
              .execute();

            if (plan.destroyed > 0) {
              // The batch total spans every clinic, so it drops by what this
              // clinic destroyed, never to this clinic's balance.
              await trx
                .updateTable("drug_batches")
                .set({
                  quantity_remaining: sql<number>`GREATEST(0, quantity_remaining - ${plan.destroyed})`,
                  updated_at: sql`now()::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                })
                .where("id", "=", row.batch_id)
                .execute();
            }
          }

          return rows.map(planRowRemoval).reduce<DrugRemovalOutcome>(
            (total, plan) => ({
              batches_cleared: total.batches_cleared + (plan.keepRow ? 0 : 1),
              batches_retained: total.batches_retained + (plan.keepRow ? 1 : 0),
              units_destroyed: total.units_destroyed + plan.destroyed,
              units_retained: total.units_retained + plan.retained,
            }),
            {
              batches_cleared: 0,
              batches_retained: 0,
              units_destroyed: 0,
              units_retained: 0,
            },
          );
        });
      },
    );
  }

  export namespace Sync {
    /**
     * This namespace is limited since clinic_inventory is server-only
     * and should never be modified from the client
     */

    /**
     * Get inventory for sync to mobile (read-only)
     */
    export const getForMobileSync = createServerOnlyFn(
      async (clinicId: string): Promise<EncodedT[]> => {
        const results = await db
          .selectFrom(Table.name)
          .selectAll()
          .where("clinic_id", "=", clinicId)
          .where("is_deleted", "=", false)
          .execute();

        return results as EncodedT[];
      },
    );
  }
}

export default ClinicInventory;
