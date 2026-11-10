/**
 * Super-admin server functions backing the "HERS monitoring" settings section:
 * client credentials, webhook registration, and clinic location subscriptions.
 *
 * Secrets only travel inwards: the signing key and webhook secret are stored
 * in server variables and never returned to the browser.
 */

import {
  HersApiError,
  HersClient,
  HersError,
  HersValidationError,
} from "@hikmahealth/hers";
import type { ClientDetails, LocationSubscription } from "@hikmahealth/hers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { superAdminMiddleware } from "@/middleware/auth";
import { logAdminAudit } from "@/lib/server-functions/audit";
import Clinic from "@/models/clinic";
import {
  clearHersState,
  createHersClient,
  getHersClient,
  HERS_ANOMALY_EVENT,
  HERS_FEATURES,
  hersRequestOptions,
  readHersCredentials,
  readHersLocations,
  readHersWebhook,
  saveHersCredentials,
  saveHersLocations,
  saveHersWebhook,
  type HersLocationRecord,
} from "@/lib/hers/store";

const WEBHOOK_PATH = "/api/hers/webhook";
const ERROR_MESSAGE_LIMIT = 300;
const AUDIT_TABLE = "hers_monitoring";

export type HersFeature = (typeof HERS_FEATURES)[number];

export type HersClinicView = {
  id: string;
  name: string;
  /** Present once the clinic is registered with HERS. */
  location: HersLocationRecord | null;
};

export type HersSettingsView = {
  credentials:
    { isSet: false } | { isSet: true; baseUrl: string; clientId: string };
  webhook: {
    url: string;
    events: string[];
    registeredAt: string;
  } | null;
  /** This server's webhook endpoint, when its public URL is known. */
  suggestedWebhookUrl: string | null;
  defaultBaseUrl: string;
  features: readonly HersFeature[];
  clinics: HersClinicView[];
};

export type HersConnectionView =
  | { ok: true; client: ClientDetails; subscriptions: LocationSubscription[] }
  | { ok: false; message: string };

/** A message safe to show in the browser: no stack, no secrets, bounded length. */
function describeError(error: unknown, fallback: string): string {
  let message = fallback;
  if (error instanceof HersValidationError) {
    const detail =
      typeof error.error === "string"
        ? error.error
        : JSON.stringify(error.error);
    message = `HERS rejected the request: ${detail}`;
  } else if (error instanceof HersApiError) {
    message =
      error.status === 401
        ? "HERS rejected the credentials"
        : error.status === 403
          ? "This HERS client is missing the scope needed for this action"
          : error.message;
  } else if (error instanceof HersError || error instanceof Error) {
    message =
      error.name === "TimeoutError"
        ? "HERS did not respond in time"
        : error.message;
  }
  return message.length > ERROR_MESSAGE_LIMIT
    ? `${message.slice(0, ERROR_MESSAGE_LIMIT)}…`
    : message;
}

/** Runs a HERS call, rethrowing failures as browser-safe errors. */
async function withHersErrors<T>(fallback: string, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    console.error(`${fallback}:`, error);
    throw new Error(describeError(error, fallback));
  }
}

// Read at call time from process.env: `@/env` only sees build-time values on the server.
const getSuggestedWebhookUrl = (): string | null => {
  const appUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
  return appUrl ? new URL(WEBHOOK_PATH, appUrl).href : null;
};

const baseUrlField = z
  .url()
  .trim()
  .transform((url) => url.replace(/\/+$/, ""));

export const getHersSettings = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async (): Promise<HersSettingsView> => {
    const [credentials, webhook, locations, clinics] = await Promise.all([
      readHersCredentials(),
      readHersWebhook(),
      readHersLocations(),
      Clinic.getAll({ includeUsers: false }),
    ]);

    return {
      credentials: credentials
        ? {
            isSet: true,
            baseUrl: credentials.base_url,
            clientId: credentials.client_id,
          }
        : { isSet: false },
      webhook: webhook
        ? {
            url: webhook.url,
            events: webhook.events,
            registeredAt: webhook.registered_at,
          }
        : null,
      suggestedWebhookUrl: getSuggestedWebhookUrl(),
      defaultBaseUrl: process.env.HERS_CLIENT_URL ?? "",
      features: HERS_FEATURES,
      clinics: clinics
        .map((clinic) => ({
          id: clinic.id,
          name: clinic.name ?? "Unnamed clinic",
          location: locations[clinic.id] ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

/** Checks the stored credentials against HERS and lists its subscriptions. */
export const checkHersConnection = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async (): Promise<HersConnectionView> => {
    try {
      const hers = await getHersClient();
      const [status, subscriptions] = await Promise.all([
        hers.status(hersRequestOptions()),
        hers.ems.listSubscriptions({}, hersRequestOptions()),
      ]);
      return { ok: true, client: status.client, subscriptions };
    } catch (error) {
      return {
        ok: false,
        message: describeError(error, "Failed to reach HERS"),
      };
    }
  });

/** Provisions a new HERS client and stores its credentials. */
export const createHersCredentials = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator(
    z.object({
      baseUrl: baseUrlField,
      name: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data, context }) => {
    const created = await withHersErrors(
      "Failed to create HERS credentials",
      () =>
        HersClient.createClient(
          {
            name: data.name,
            description: "Hikma Health EHR environmental monitoring",
          },
          { baseUrl: data.baseUrl, ...hersRequestOptions() },
        ),
    );

    // The signing key is only returned once: save it before anything else can fail.
    await saveHersCredentials({
      base_url: data.baseUrl,
      client_id: created.client_id,
      signing_key: created.client_signing_key.base64_encoded,
    });
    // A new client starts with no webhook or subscriptions.
    await clearHersState({ keepCredentials: true });

    await logAdminAudit(context.userId, {
      actionType: "CREATE",
      tableName: AUDIT_TABLE,
      rowId: "credentials",
      changes: { fields: ["base_url", "client_id", "signing_key"] },
      metadata: { client_id: created.client_id, base_url: data.baseUrl },
    });
    return { clientId: created.client_id };
  });

/** Stores credentials for an existing HERS client, after checking they work. */
export const saveExistingHersCredentials = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator(
    z.object({
      baseUrl: baseUrlField,
      clientId: z.string().trim().min(1),
      signingKey: z.string().trim().min(1),
    }),
  )
  .handler(async ({ data, context }) => {
    const credentials = {
      base_url: data.baseUrl,
      client_id: data.clientId,
      signing_key: data.signingKey,
    };
    const status = await withHersErrors(
      "Failed to verify HERS credentials",
      () => createHersClient(credentials).status(hersRequestOptions()),
    );

    const previous = await readHersCredentials();
    await saveHersCredentials(credentials);
    if (previous?.client_id !== credentials.client_id) {
      await clearHersState({ keepCredentials: true });
    }

    await logAdminAudit(context.userId, {
      actionType: "UPDATE",
      tableName: AUDIT_TABLE,
      rowId: "credentials",
      changes: { fields: ["base_url", "client_id", "signing_key"] },
      metadata: { client_id: credentials.client_id, base_url: data.baseUrl },
    });
    return { clientId: status.client.id };
  });

/**
 * Forgets the HERS credentials, webhook and locations on this server.
 * Nothing is deleted on HERS: the client is only disabled there by HERS admins.
 */
export const removeHersCredentials = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .handler(async ({ context }) => {
    await clearHersState();
    await logAdminAudit(context.userId, {
      actionType: "PERMANENT_DELETE",
      tableName: AUDIT_TABLE,
      rowId: "credentials",
      changes: {},
    });
    return { ok: true };
  });

/**
 * Registers (or re-registers) the webhook HERS delivers anomaly events to.
 * Re-registering the same URL rotates its secret.
 */
export const registerHersWebhook = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator(z.object({ webhookUrl: z.url().trim() }))
  .handler(async ({ data, context }) => {
    const hers = await withHersErrors("HERS is not configured", getHersClient);
    const registered = await withHersErrors(
      "Failed to register the HERS webhook",
      () =>
        hers.registerWebhook(
          {
            events: [HERS_ANOMALY_EVENT],
            webhookUrl: data.webhookUrl,
            description: "Hikma Health EHR anomaly receiver",
          },
          hersRequestOptions(),
        ),
    );

    // The secret is only returned once: save it straight away.
    await saveHersWebhook({
      id: registered.id,
      url: data.webhookUrl,
      events: registered.events,
      secret: registered.secret,
      registered_at: new Date().toISOString(),
    });

    await logAdminAudit(context.userId, {
      actionType: "CREATE",
      tableName: AUDIT_TABLE,
      rowId: "webhook",
      changes: { fields: ["url", "events", "secret"] },
      metadata: { webhook_id: registered.id, url: data.webhookUrl },
    });
    return { id: registered.id };
  });

const forecastDays = z.number().int().min(1).max(7);
const durationField = z
  .string()
  .trim()
  .regex(/^\d+[mhdw]$/, "Use a duration like 30m, 4h, 7d or 2w")
  .nullable();

/** Subscribes a clinic's location to environmental monitoring. */
export const registerHersClinicLocation = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator(
    z.object({
      clinicId: z.string().min(1),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      features: z.array(z.enum(HERS_FEATURES)).min(1),
      forecastDays,
      /** `null` monitors indefinitely. */
      duration: durationField,
    }),
  )
  .handler(async ({ data, context }) => {
    const hers = await withHersErrors("HERS is not configured", getHersClient);
    await withHersErrors(
      "Failed to register the clinic location with HERS",
      () =>
        hers.ems.subscribe(
          {
            features: data.features,
            duration: data.duration,
            metadata: { forecast_days: data.forecastDays },
            locations: [
              {
                key: data.clinicId,
                latitude: data.latitude,
                longitude: data.longitude,
              },
            ],
          },
          hersRequestOptions(),
        ),
    );

    const locations = await readHersLocations();
    locations[data.clinicId] = {
      latitude: data.latitude,
      longitude: data.longitude,
      features: data.features,
      forecast_days: data.forecastDays,
      duration: data.duration,
      registered_at: new Date().toISOString(),
    };
    await saveHersLocations(locations);

    await logAdminAudit(context.userId, {
      actionType: "UPDATE",
      tableName: AUDIT_TABLE,
      rowId: `location/${data.clinicId}`,
      changes: {
        fields: [
          "latitude",
          "longitude",
          "features",
          "forecast_days",
          "duration",
        ],
      },
      metadata: { clinic_id: data.clinicId, features: data.features },
    });
    return { ok: true };
  });

/** Stops environmental monitoring at a clinic's location. */
export const unregisterHersClinicLocation = createServerFn({ method: "POST" })
  .middleware([superAdminMiddleware])
  .validator(z.object({ clinicId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const hers = await withHersErrors("HERS is not configured", getHersClient);
    await withHersErrors(
      "Failed to unregister the clinic location from HERS",
      () =>
        hers.ems.unsubscribe(
          { location_references: [data.clinicId] },
          hersRequestOptions(),
        ),
    );

    const locations = await readHersLocations();
    delete locations[data.clinicId];
    await saveHersLocations(locations);

    await logAdminAudit(context.userId, {
      actionType: "PERMANENT_DELETE",
      tableName: AUDIT_TABLE,
      rowId: `location/${data.clinicId}`,
      changes: {},
      metadata: { clinic_id: data.clinicId },
    });
    return { ok: true };
  });
