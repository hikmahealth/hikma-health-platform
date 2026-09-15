/**
 * Sync pull query procedures.
 *
 * The RPC caller is always an authenticated user (via JWT), not a device.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { authedProcedure, createTRPCRouter } from "../../init";
import Sync from "@/models/sync";
import { getDeltaPage, DEFAULT_PAGE_ROWS } from "@/models/sync-paged";
import { countChanges, recordSyncAudit } from "@/models/sync-audit";
import { callerFromContext, resolvePeerType } from "../../caller";
import * as Sentry from "@sentry/tanstackstart-react";

export const syncQueryRouter = createTRPCRouter({
  /**
   * Pull changes since last sync timestamp.
   *
   * Returns `{ changes, timestamp }`, matching the REST `/api/v2/sync` GET
   * response.
   */
  pull: authedProcedure
    .input(
      z.object({
        last_pulled_at: z.number().int().nonnegative(),
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
    .query(async ({ input, ctx }) => {
      const startedAt = Date.now();
      let auditPeerType: string = input.peer_type ?? "unknown";
      try {
        const caller = await callerFromContext(ctx);
        const peerType = resolvePeerType(input.peer_type, caller);
        auditPeerType = peerType;
        const syncTimestamp = Date.now();
        const changes = await Sync.getDeltaRecords(
          input.last_pulled_at,
          peerType,
          caller,
        );
        await recordSyncAudit({
          feature: "sync",
          userId: ctx.userId,
          direction: "pull",
          peerType,
          since: input.last_pulled_at,
          snapshotTs: syncTimestamp,
          startedAt,
          counts: countChanges(changes),
          outcome: "completed",
        });
        return { changes, timestamp: syncTimestamp };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Sync pull failed";
        await recordSyncAudit({
          feature: "sync",
          userId: ctx.userId,
          direction: "pull",
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
   * One page of a resumable, memory-bounded backfill.
   *
   * Unlike `pull`, which returns the whole delta in a single response, this
   * returns at most `page_bytes` of rows and an opaque cursor to resume from.
   * `timestamp` is a snapshot captured on the first page and repeated on every
   * later page — clients advance their own cursor to it only once the run
   * completes.
   */
  backfillPull: authedProcedure
    .input(
      z.object({
        since: z.number().int().nonnegative(),
        cursor: z.string().nullable(),
        page_bytes: z.number().int().positive(),
        page_rows: z.number().int().positive().optional(),
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
    .query(async ({ input, ctx }) => {
      const startedAt = Date.now();
      const caller = await callerFromContext(ctx);
      const peerType = resolvePeerType(input.peer_type, caller);

      // A null cursor is the first page of a run. The start is recorded before
      // any data is read, so a run that dies mid-way leaves a start with no
      // terminal row — the audit helper swallows its own failures, and that
      // asymmetry is what makes one visible. A client retrying its first page
      // writes a second start; two starts against one completion reads as the
      // retry it was, so this is deliberately not deduplicated.
      if (input.cursor === null) {
        await recordSyncAudit({
          feature: "manual_sync",
          userId: ctx.userId,
          direction: "pull",
          peerType: String(peerType),
          since: input.since,
          // The snapshot is not taken until the first query runs, so the start
          // row carries the request time instead.
          snapshotTs: Date.now(),
          startedAt,
          counts: {},
          outcome: "started",
        });
      }

      try {
        const page = await getDeltaPage({
          since: input.since,
          cursor: input.cursor,
          pageBytes: input.page_bytes,
          pageRows: input.page_rows ?? DEFAULT_PAGE_ROWS,
          peerType,
          caller,
        });

        // Audit the whole operation once, when it finishes, rather than once
        // per page — a 2,500-page backfill must not write 2,500 audit rows.
        // The totals cover the entire run: they ride in the cursor, because the
        // server holds nothing between pages.
        if (page.nextCursor === null) {
          await recordSyncAudit({
            feature: "manual_sync",
            userId: ctx.userId,
            direction: "pull",
            peerType: String(peerType),
            since: input.since,
            snapshotTs: page.timestamp,
            // The run's snapshot is taken when its first page starts.
            startedAt: page.timestamp,
            counts: page.totals,
            outcome: "completed",
          });
        }

        return {
          changes: page.changes,
          next_cursor: page.nextCursor,
          timestamp: page.timestamp,
          progress: {
            table: page.progress.table,
            bucket: page.progress.bucket,
            tables_remaining: page.progress.tablesRemaining,
          },
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Backfill pull failed";

        await recordSyncAudit({
          feature: "manual_sync",
          userId: ctx.userId,
          direction: "pull",
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
