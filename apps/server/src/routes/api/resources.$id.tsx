import { createFileRoute } from "@tanstack/react-router";
import { minutesToMilliseconds } from "date-fns";
import { Logger } from "@hikmahealth/js-utils";
import db from "@/db";
import {
  createRateLimiter,
  getClientIp,
  tooManyRequestsResponse,
} from "@/lib/rate-limiter";
import { getAdapterForStore } from "@/storage/factory";
import { ResourceStoreUnavailableError } from "@/storage/errors";
import { isStoreType } from "@/storage/types";

/**
 * Unauthenticated, and a hit now costs a full object download from whichever
 * backend holds the file. Without a cap, a published resource id is a lever
 * for running up someone else's cloud egress bill.
 */
const downloadLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(1),
  maxRequests: 120,
});

export const Route = createFileRoute("/api/resources/$id")({
  server: {
    handlers: {
      GET: async ({
        request,
        params,
      }: {
        request: Request;
        params: { id: string };
      }) => {
        const limit = downloadLimiter.check(getClientIp(request));
        if (!limit.allowed) return tooManyRequestsResponse(limit.retryAfterMs);

        const resource = await db
          .selectFrom("resources")
          .selectAll()
          .where("id", "=", params.id)
          .executeTakeFirst();

        if (!resource) {
          return new Response("Not found", { status: 404 });
        }

        // Only serve resources linked to published + public education content.
        // This prevents enumeration of private/draft resources.
        const linkedContent = await db
          .selectFrom("education_content")
          .select("id")
          .where("resource_id", "=", resource.id)
          .where("is_deleted", "=", false)
          .where("status", "=", "published")
          .where("visibility", "=", "public")
          .executeTakeFirst();

        if (!linkedContent) {
          return new Response("Not found", { status: 404 });
        }

        // Read from wherever the file was written, not the active backend, so
        // changing backends never orphans existing content.
        if (!isStoreType(resource.store)) {
          Logger.error({
            msg: "[api.resources] resource names an unknown storage backend",
            resourceId: resource.id,
            store: resource.store,
          });
          return new Response("Failed to read resource", { status: 500 });
        }

        try {
          const adapter = await getAdapterForStore(resource.store);
          const bytes = await adapter.downloadAsBytes(resource.uri);

          return new Response(bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": resource.mimetype,
              "Cache-Control": "public, max-age=86400",
            },
          });
        } catch (error) {
          if (error instanceof ResourceStoreUnavailableError) {
            Logger.error({
              msg: "[api.resources] storage backend unavailable",
              store: resource.store,
              error,
            });
            return new Response("Storage backend unavailable", { status: 503 });
          }
          Logger.error({ msg: "[api.resources] read failed", error });
          return new Response("Failed to read resource", { status: 500 });
        }
      },
    },
  },
});
