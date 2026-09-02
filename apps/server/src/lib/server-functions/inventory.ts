import * as Sentry from "@sentry/tanstackstart-react";

import ClinicInventory from "@/models/clinic-inventory";
import DrugBatches from "@/models/drug-batches";
import { createServerFn } from "@tanstack/react-start";
import { v1 as uuidV1 } from "uuid";
import { Result } from "@/lib/result";
import { adminMiddleware } from "@/middleware/auth";

export const getClinicInventory = createServerFn({ method: "GET" })
  .validator(
    (params: {
      clinicId: string;
      searchQuery?: string;
      limit?: number;
      offset?: number;
    }) => params,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return Sentry.startSpan(
      { name: "Get clinic inventory with drug info" },
      async () => {
        try {
          const [items, total] = await Promise.all([
            ClinicInventory.API.getWithDrugInfo(
              data.clinicId,
              data.searchQuery ?? "",
              {
                limit: data.limit ?? 100,
                offset: data.offset ?? 0,
                includeZeroStock: true,
              },
            ),
            ClinicInventory.API.countStockedDrugs(
              data.clinicId,
              data.searchQuery ?? "",
              { includeZeroStock: true },
            ),
          ]);

          // Estimated from whether the page came back full, to avoid a count query.
          const hasMore = items.length === (data.limit ?? 100);

          return Result.ok({ items, hasMore, total });
        } catch (error) {
          Sentry.captureException(error);
          return Result.err({
            _tag: "ServerError" as const,
            message:
              error instanceof Error
                ? error.message
                : "Failed to fetch inventory",
          });
        }
      },
    );
  });

export const getClinicInventoryById = createServerFn({ method: "GET" })
  .validator((params: { id: string }) => params)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return Sentry.startSpan(
      { name: "Get clinic inventory item by ID" },
      async () => {
        try {
          const item = await ClinicInventory.API.getById(data.id);
          return Result.ok(item || null);
        } catch (error) {
          Sentry.captureException(error);
          return Result.err({
            _tag: "ServerError" as const,
            message:
              error instanceof Error
                ? error.message
                : "Failed to fetch inventory item",
          });
        }
      },
    );
  });

export const getBatchesByDrug = createServerFn({ method: "GET" })
  .validator(
    (params: {
      drugId: string;
      onlyAvailable?: boolean;
      includeQuarantined?: boolean;
    }) => params,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: "Get batches for drug" }, async () => {
      try {
        const batches = await DrugBatches.API.getByDrugId(data.drugId, {
          onlyAvailable: data.onlyAvailable ?? true,
          includeQuarantined: data.includeQuarantined ?? false,
          limit: 100,
        });

        return Result.ok(batches || []);
      } catch (error) {
        Sentry.captureException(error);
        return Result.err({
          _tag: "ServerError" as const,
          message:
            error instanceof Error ? error.message : "Failed to fetch batches",
        });
      }
    });
  });

export const getClinicDrugStock = createServerFn({ method: "GET" })
  .validator((params: { clinicId: string; drugId: string }) => params)
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return Sentry.startSpan(
      { name: "Get clinic stock for drug" },
      async () => {
        try {
          const stock = await ClinicInventory.API.getClinicDrugStock(
            data.clinicId,
            data.drugId,
          );
          return Result.ok(stock);
        } catch (error) {
          Sentry.captureException(error);
          return Result.err({
            _tag: "ServerError" as const,
            message:
              error instanceof Error
                ? error.message
                : "Failed to fetch clinic stock",
          });
        }
      },
    );
  });

/** Takes a drug off one clinic's shelves, writing off the stock held there. */
export const removeDrugFromClinic = createServerFn({ method: "POST" })
  .validator(
    (data: { clinicId: string; drugId: string; reason?: string }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data, context }) => {
    return Sentry.startSpan({ name: "Remove drug from clinic" }, async () => {
      try {
        const outcome = await ClinicInventory.API.removeDrugFromClinic({
          clinicId: data.clinicId,
          drugId: data.drugId,
          performedBy: context.userId,
          reason: data.reason,
        });
        return { success: true as const, data: outcome };
      } catch (error) {
        Sentry.captureException(error);
        return {
          success: false as const,
          error:
            error instanceof Error
              ? error.message
              : "Failed to remove drug from clinic",
        };
      }
    });
  });

export const saveClinicInventory = createServerFn({ method: "POST" })
  .validator(
    (data: {
      id: string | null;
      clinicId: string;
      drugId: string;
      batchNumber: string;
      batchExpiryDate: Date;
      batchId: string;
      quantityAvailable: number;
      metadata?: Record<string, any>;
      recordedByUserId: string;
      isNew: boolean;
    }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return Sentry.startSpan(
      { name: "Save clinic inventory item" },
      async () => {
        try {
          if (data.isNew) {
            // updateQuantity creates the row when it is missing.
            const result = await ClinicInventory.API.updateQuantity({
              clinicId: data.clinicId,
              drugId: data.drugId,
              batchId: data.batchId,
              batchNumber: data.batchNumber,
              batchExpiryDate: data.batchExpiryDate,
              quantityChange: data.quantityAvailable,
              transactionType: "receiving",
              reason: "Initial stock",
              performedBy: data.recordedByUserId,
            });
            return { success: true, data: result };
          } else {
            const existing = await ClinicInventory.API.getById(data.id!);
            if (!existing) {
              throw new Error("Inventory item not found");
            }

            const quantityChange =
              data.quantityAvailable - existing.quantity_available;
            const transactionType =
              quantityChange > 0 ? "receiving" : "adjustment";

            const result = await ClinicInventory.API.updateQuantity({
              clinicId: data.clinicId,
              drugId: data.drugId,
              batchId: data.batchId,
              batchNumber: data.batchNumber,
              batchExpiryDate: data.batchExpiryDate,
              quantityChange: quantityChange,
              transactionType: transactionType,
              reason: "Stock update",
              performedBy: data.recordedByUserId,
            });
            return { success: true, data: result };
          }
        } catch (error) {
          Sentry.captureException(error);
          return { success: false, error: String(error) };
        }
      },
    );
  });

export const createDrugBatch = createServerFn({ method: "POST" })
  .validator(
    (data: {
      drugId: string;
      clinicId: string;
      batchNumber: string;
      expiryDate: string;
      manufactureDate?: string;
      quantityReceived: number;
      supplierName?: string;
      purchasePrice?: number;
      purchaseCurrency?: string;
      recordedByUserId: string;
      notes?: string;
    }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    return Sentry.startSpan({ name: "Create drug batch" }, async () => {
      // TODO: this should be a transaction
      try {
        const batchData: Partial<DrugBatches.EncodedT> = {
          id: uuidV1(),
          drug_id: data.drugId,
          batch_number: data.batchNumber,
          expiry_date: new Date(data.expiryDate),
          manufacture_date: data.manufactureDate
            ? new Date(data.manufactureDate)
            : null,
          quantity_received: data.quantityReceived,
          quantity_remaining: data.quantityReceived,
          supplier_name: data.supplierName || null,
          purchase_price: data.purchasePrice || null,
          purchase_currency: data.purchaseCurrency || "USD",
          received_date: new Date(),
          is_quarantined: false,
          recorded_by_user_id: data.recordedByUserId,
          metadata: {},
          is_deleted: false,
        };

        const batchResult = await DrugBatches.API.upsert(batchData);

        if (batchResult && data.clinicId) {
          await ClinicInventory.API.updateQuantity({
            clinicId: data.clinicId,
            drugId: data.drugId,
            batchId: batchResult.id,
            batchNumber: data.batchNumber,
            batchExpiryDate: new Date(data.expiryDate),
            quantityChange: data.quantityReceived,
            transactionType: "receiving",
            reason: `New batch received - Batch #${data.batchNumber}${data.notes ? ` - ${data.notes}` : ""}`,
            performedBy: data.recordedByUserId,
          });
        }

        return { success: true, data: batchResult };
      } catch (error) {
        Sentry.captureException(error);
        return { success: false, error: String(error) };
      }
    });
  });
