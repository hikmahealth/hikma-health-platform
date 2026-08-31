import { createFileRoute } from "@tanstack/react-router";
import { createServerOnlyFn } from "@tanstack/react-start";
import User from "@/models/user";
import Sync from "@/models/sync";
import { match, P } from "ts-pattern";
import Device from "@/models/device";
import {
  createRateLimiter,
  getClientIp,
  tooManyRequestsResponse,
} from "@/lib/rate-limiter";
import type { RequestCaller } from "@/types";
import Clinic from "@/models/clinic";
import { Option } from "@/lib/option";
import { Result } from "@/lib/result";
import { minutesToMilliseconds } from "date-fns";
import { Logger } from "@hikmahealth/js-utils";

const syncLimiter = createRateLimiter({
  windowMs: minutesToMilliseconds(1),
  maxRequests: 60,
});

export const Route = createFileRoute("/api/v2/sync")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const ip = getClientIp(request);
        const limit = syncLimiter.check(ip);
        if (!limit.allowed) return tooManyRequestsResponse(limit.retryAfterMs);

        try {
          const url = new URL(request.url);
          const last_synced_at = Number(
            url.searchParams.get("last_pulled_at") ||
              url.searchParams.get("lastPulledAt") ||
              0,
          );
          const schemaVersion = url.searchParams.get("schemaVersion");
          const migration = url.searchParams.get("migration");
          const peerType: Device.DeviceTypeT =
            (url.searchParams.get("peerType") as Device.DeviceTypeT) ||
            "unknown"; // Get the peer type or else return "unknown". Unknown is treated as a mobile to be a safe fallback.

          Logger.Production.info("Sync Attempt started");
          const authenticatedCaller = await authenticateRequest(
            request,
            peerType,
          );
          return match(authenticatedCaller)
            .with({ ok: false }, () => {
              return new Response(JSON.stringify({ error: "Unauthorized" }), {
                headers: { "Content-Type": "application/json" },
                status: 401,
              });
            })
            .with({ ok: true }, async ({ data: caller }) => {
              // Stamped before the queries run, so the client's next sync covers
              // anything written while they execute.
              const syncTimestamp = Date.now();

              const dbChangeSet = await Sync.getDeltaRecords(
                last_synced_at,
                peerType,
                caller,
              );
              const changeSetSize = Object.values(dbChangeSet)
                .map(
                  (entry) =>
                    entry.created.length +
                    entry.updated.length +
                    entry.deleted.length,
                )
                .reduce((a, b) => a + b, 0);
              Logger.log({
                timestamp: syncTimestamp,
                dataPulled: changeSetSize,
              });

              return new Response(
                JSON.stringify({
                  success: true,
                  changes: dbChangeSet,
                  timestamp: syncTimestamp,
                }),
                {
                  headers: { "Content-Type": "application/json" },
                  status: 200,
                },
              );
            })
            .exhaustive();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Internal server error";
          Logger.Production.error({ error });
          const isAuthError =
            message.includes("Unauthorized") ||
            message.includes("Authorization header") ||
            message.includes("Invalid credentials");
          return new Response(JSON.stringify({ error: message }), {
            headers: { "Content-Type": "application/json" },
            status: isAuthError ? 401 : 500,
          });
        }
      },
      POST: async ({ request }) => {
        const postIp = getClientIp(request);
        const postLimit = syncLimiter.check(postIp);
        if (!postLimit.allowed) {
          return tooManyRequestsResponse(postLimit.retryAfterMs);
        }

        try {
          const url = new URL(request.url);
          const last_synced_at = Number(
            url.searchParams.get("last_pulled_at") || 0,
          );
          const schemaVersion = url.searchParams.get("schemaVersion");
          const migration = url.searchParams.get("migration");
          const peerType: Device.DeviceTypeT =
            (url.searchParams.get("peerType") as Device.DeviceTypeT) ||
            "unknown"; // Get the peer type or else return "android"
          const authenticatedCaller = await authenticateRequest(
            request,
            peerType,
          );

          return match(authenticatedCaller)
            .with({ ok: false }, () => {
              return new Response(JSON.stringify({ error: "Unauthorized" }), {
                headers: { "Content-Type": "application/json" },
                status: 401,
              });
            })
            .with({ ok: true }, async ({ data: caller }) => {
              const body = (await request.json()) as Sync.PushRequest;

              await Sync.persistClientChanges(body, peerType, caller);
              return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" },
                status: 200,
              });
            })
            .exhaustive();
        } catch (error) {
          Logger.error(error);
          const message =
            error instanceof Error ? error.message : "Internal server error";
          const isAuthError =
            message.includes("Unauthorized") ||
            message.includes("Authorization header") ||
            message.includes("Invalid credentials");
          const isBadRequest = error instanceof SyntaxError; // JSON.parse failure
          const status = isAuthError ? 401 : isBadRequest ? 400 : 500;
          return new Response(JSON.stringify({ error: message }), {
            headers: { "Content-Type": "application/json" },
            status,
          });
        }
      },
    },
  },
});

const authenticateRequest = createServerOnlyFn(
  async (
    request: Request,
    peerType: Device.DeviceTypeT,
  ): Promise<Result<RequestCaller>> => {
    try {
      const authHeader = request.headers.get("Authorization");
      const isBearerToken = authHeader?.startsWith("Bearer ");
      if (!authHeader || (!authHeader.startsWith("Basic ") && !isBearerToken)) {
        throw new Error("Authorization header missing or invalid");
      }

      const encodedCredentials = authHeader.split(" ")[1];

      // `peerType` is caller-supplied. Hub peers receive a wider entity set
      // (users, devices, device pin codes) and are exempt from user-level
      // clinic scoping, so the claim is only honoured for callers presenting a
      // device API key. A user-credential login claiming sync_hub is rejected.
      if (peerType === Device.DEVICE_TYPE.SYNC_HUB && !isBearerToken) {
        return Result.err({
          _tag: "PermissionDenied",
          permission: "Connection to server Refused",
          message: "sync_hub peer type requires device API key authentication",
        });
      }

      if (isBearerToken && peerType === Device.DEVICE_TYPE.SYNC_HUB) {
        // The bearer credential here is the device API key, not a session token.
        const deviceResult = await Device.API.getByApiKey(encodedCredentials);
        if (!deviceResult) {
          return Result.err({
            _tag: "PermissionDenied",
            permission: "Connection to server Refused",
            message: "Invalid device credentials",
          });
        } else {
          return Result.ok({
            device: deviceResult,
          });
        }
      }

      // Device-by-user-credentials sync path (vs. device-API-key above).
      const decodedCredentials = Buffer.from(
        encodedCredentials,
        "base64",
      ).toString();
      const user =
        await getAuthenticatedUserFromCredentials(decodedCredentials);
      let clinic: Option<Clinic.EncodedT> = Option.none;

      if (user.clinic_id) {
        const userClinicResult = await Clinic.getById(user.clinic_id);
        clinic = Option.some(userClinicResult);
      }

      return Result.ok({
        user,
        clinic,
      });
    } catch (error: any) {
      Logger.error({
        msg: "[authenticatedRequest] Error authenticating a request. Error: ",
        error,
      });
      return Result.err({
        _tag: "Unauthorized",
        message: error?.message || "Permission Denied",
      });
    }
  },
);

/**
 * Authenticate one sync request from Basic credentials. Verifies rather than
 * signing in — every pull and push carries these credentials, so `signIn`
 * would mint a token per request that no client receives.
 */
const getAuthenticatedUserFromCredentials = createServerOnlyFn(
  async (credentials: string) => {
    const [email, password] = credentials.split(":");
    if (!email || !password) {
      throw new Error("Invalid credentials format");
    }

    return await User.verifyCredentials(email, password);
  },
);

// TODO: sync endpoint needs to support old mobile app.
