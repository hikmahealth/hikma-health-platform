/**
 * Persistence for the HERS environmental monitoring integration, plus a
 * factory for an authenticated SDK client.
 *
 * Everything lives in `server_variables` as JSON rows:
 * - credentials: the HERS client id and Ed25519 signing key
 * - webhook: the registered webhook and its `whsec_` signing secret
 * - locations: the coordinates registered per clinic (HERS only echoes back
 *   the location reference, so we keep the coordinates for display)
 *
 * Node only: the `@hikmahealth/hers` SDK depends on `node:crypto`.
 */

import { HersClient } from "@hikmahealth/hers";
import type { Feature } from "@hikmahealth/hers";
import { z } from "zod";
import ServerVariable from "@/models/server_variable";

export const HERS_ANOMALY_EVENT = "environment.anomaly_detected";
export const HERS_FEATURES = [
	"temperature",
	"pm_2_5",
] as const satisfies readonly Feature[];
export const HERS_REQUEST_TIMEOUT_MS = 15_000;

const credentialsSchema = z.object({
	base_url: z.url(),
	client_id: z.string().min(1),
	/** Base64 PKCS#8 DER Ed25519 private key. HERS only returns it once. */
	signing_key: z.string().min(1),
});
export type HersCredentials = z.infer<typeof credentialsSchema>;

const webhookSchema = z.object({
	id: z.string().min(1),
	url: z.url(),
	events: z.array(z.string()),
	/** `whsec_...` secret used to verify deliveries. HERS only returns it once. */
	secret: z.string().min(1),
	registered_at: z.string(),
});
export type HersWebhookRecord = z.infer<typeof webhookSchema>;

const locationSchema = z.object({
	latitude: z.number(),
	longitude: z.number(),
	features: z.array(z.enum(HERS_FEATURES)),
	forecast_days: z.number().int(),
	duration: z.string().nullable(),
	registered_at: z.string(),
});
export type HersLocationRecord = z.infer<typeof locationSchema>;

/** Registered locations keyed by clinic id (also the HERS location reference). */
const locationsSchema = z.record(z.string(), locationSchema);
export type HersLocations = z.infer<typeof locationsSchema>;

const Keys = ServerVariable.Keys;

async function readJson<T>(
	key: string,
	schema: z.ZodType<T>,
): Promise<T | null> {
	try {
		const value = await ServerVariable.getAsJson(key);
		if (value == null) return null;
		const parsed = schema.safeParse(value);
		return parsed.success ? parsed.data : null;
	} catch (error) {
		// Wrong value type or corrupt JSON: treat as not configured.
		console.error(`Failed to read server variable "${key}":`, error);
		return null;
	}
}

export const readHersCredentials = () =>
	readJson(Keys.HERS_CREDENTIALS, credentialsSchema);

export async function saveHersCredentials(credentials: HersCredentials) {
	await ServerVariable.setJson(
		Keys.HERS_CREDENTIALS,
		credentialsSchema.parse(credentials),
		"HERS environmental monitoring client credentials",
	);
}

export const readHersWebhook = () => readJson(Keys.HERS_WEBHOOK, webhookSchema);

export async function saveHersWebhook(webhook: HersWebhookRecord) {
	await ServerVariable.setJson(
		Keys.HERS_WEBHOOK,
		webhookSchema.parse(webhook),
		"HERS webhook registration and signing secret",
	);
}

export async function readHersLocations(): Promise<HersLocations> {
	return (await readJson(Keys.HERS_LOCATIONS, locationsSchema)) ?? {};
}

export async function saveHersLocations(locations: HersLocations) {
	await ServerVariable.setJson(
		Keys.HERS_LOCATIONS,
		locationsSchema.parse(locations),
		"Clinic locations registered for HERS environmental monitoring",
	);
}

/**
 * Forget everything tied to the current HERS client. Webhooks and location
 * subscriptions belong to a client, so they are meaningless once it changes.
 */
export async function clearHersState({
	keepCredentials = false,
}: { keepCredentials?: boolean } = {}) {
	await Promise.all([
		keepCredentials
			? Promise.resolve()
			: ServerVariable.clearValue(Keys.HERS_CREDENTIALS),
		ServerVariable.clearValue(Keys.HERS_WEBHOOK),
		ServerVariable.clearValue(Keys.HERS_LOCATIONS),
	]);
}

export function createHersClient(credentials: HersCredentials): HersClient {
	return new HersClient({
		baseUrl: credentials.base_url,
		credentials: {
			clientId: credentials.client_id,
			signingKey: credentials.signing_key,
		},
	});
}

/** An authenticated client from the stored credentials. Throws if none are set. */
export async function getHersClient(): Promise<HersClient> {
	const credentials = await readHersCredentials();
	if (!credentials) {
		throw new Error("HERS credentials are not configured");
	}
	return createHersClient(credentials);
}

/** Request options with a timeout, so an unreachable HERS can't hang a request. */
export const hersRequestOptions = () => ({
	signal: AbortSignal.timeout(HERS_REQUEST_TIMEOUT_MS),
});
