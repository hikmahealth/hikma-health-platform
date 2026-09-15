/**
 * Sync push command procedures.
 *
 * The RPC caller is always an authenticated user (via JWT), not a device.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { authedProcedure, createTRPCRouter } from "../../init";
import Sync from "@/models/sync";
import { acceptedCounts, recordSyncAudit } from "@/models/sync-audit";
import { callerFromContext, resolvePeerType } from "../../caller";
import * as Sentry from "@sentry/tanstackstart-react";

// The sync push payload is a record of table names to delta data.
// We use z.record with a loose schema since the Sync model validates internally.
const deltaDataSchema = z.object({
  created: z.array(z.record(z.string(), z.any())).optional().default([]),
  updated: z.array(z.record(z.string(), z.any())).optional().default([]),
  deleted: z.array(z.string()).optional().default([]),
});

export const syncCommandRouter = createTRPCRouter({
  /**
   * Push client changes to the server.
   *
   * The `changes` payload matches the REST POST `/api/v2/sync` body format, and
   * success returns an empty object to match the hub spec.
   *
   * Server-authoritative tables — users, registration_forms, event_forms — are
   * silently skipped by `Sync.persistClientChanges`.
   */
  push: authedProcedure
    .input(
      z.object({
        last_pulled_at: z.number().int().nonnegative(),
        changes: z.record(z.string(), deltaDataSchema),
        peer_type: z
          .enum([
            "android",
            "ios",
            "web",
            "desktop",
            "sync_hub",
            "laptop",
            "unknown",
          ])
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const startedAt = Date.now();
      let auditPeerType: string = input.peer_type ?? "unknown";
      try {
        const caller = await callerFromContext(ctx);
        const peerType = resolvePeerType(input.peer_type, caller);
        auditPeerType = peerType;
        const outcome = await Sync.persistClientChanges(
          input.changes as any,
          peerType,
          caller,
        );
        await recordSyncAudit({
          feature: "sync",
          userId: ctx.userId,
          direction: "push",
          peerType,
          since: input.last_pulled_at,
          startedAt,
          counts: acceptedCounts(outcome.byTable),
          byTable: outcome.byTable,
          outcome: "completed",
        });
        return {};
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Sync push failed";
        await recordSyncAudit({
          feature: "sync",
          userId: ctx.userId,
          direction: "push",
          peerType: auditPeerType,
          since: input.last_pulled_at,
          startedAt,
          counts: {},
          outcome: "failed",
          error: message,
        });
        if (error instanceof TRPCError) throw error;
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),

  /**
   * Accept a client push and report what was rejected.
   *
   * Unlike `push`, which returns only success, this returns the ids the
   * staleness guard or the clinic-authorization check dropped. The client keeps
   * those records pending instead of marking them synced — without that, a
   * rejected edit is silently discarded and then overwritten by the next pull.
   *
   * `since` is not a filter: the payload is whatever the client chose to send.
   * It is carried so the audit row can say which window the client believed it
   * was reconciling.
   *
   * There is no "started" row to match the paged pull's. The client splits a
   * push, so every call is a complete unit of work the server either finished
   * or failed — a start row would say nothing the terminal row does not.
   */
  backfillPush: authedProcedure
    .input(
      z.object({
        changes: z.record(z.string(), deltaDataSchema),
        since: z.number().int().nonnegative(),
        peer_type: z
          .enum([
            "android",
            "ios",
            "web",
            "desktop",
            "sync_hub",
            "laptop",
            "unknown",
          ])
          .optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const startedAt = Date.now();
      const caller = await callerFromContext(ctx);
      const peerType = resolvePeerType(input.peer_type, caller);

      try {
        const outcome = await Sync.persistClientChanges(
          input.changes as any,
          peerType,
          caller,
        );

        await recordSyncAudit({
          feature: "manual_sync",
          userId: ctx.userId,
          direction: "push",
          peerType: String(peerType),
          since: input.since,
          snapshotTs: Date.now(),
          startedAt,
          counts: acceptedCounts(outcome.byTable),
          byTable: outcome.byTable,
          outcome: "completed",
        });

        return {
          accepted: outcome.accepted,
          rejected: outcome.rejected,
          by_table: outcome.byTable,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Backfill push failed";

        await recordSyncAudit({
          feature: "manual_sync",
          userId: ctx.userId,
          direction: "push",
          peerType: String(peerType),
          since: input.since,
          snapshotTs: Date.now(),
          startedAt,
          counts: {},
          outcome: "failed",
          error: message,
        });

        if (error instanceof TRPCError) throw error;
        Sentry.captureException(error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message,
        });
      }
    }),
});
