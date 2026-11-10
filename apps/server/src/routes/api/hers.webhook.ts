import { createFileRoute } from "@tanstack/react-router";
import type { HersWebhookEvent } from "@hikmahealth/hers";
import {
	verifyWebhook,
	WebhookVerificationError,
	type VerifiedWebhook,
} from "@hikmahealth/hers/webhooks";
import { Logger } from "@hikmahealth/js-utils";
import { handleAnomalyDetected } from "@/lib/hers/anomaly";
import { HERS_ANOMALY_EVENT, readHersWebhook } from "@/lib/hers/store";

/**
 * Delivery ids seen recently. HERS retries with the same `webhook-id`, so this
 * stops a retry from re-running classification. In-memory only: a restart or a
 * multi-instance deployment can still process a delivery twice.
 */
const MAX_SEEN_DELIVERIES = 1_000;
const seenDeliveries = new Set<string>();

const markSeen = (id: string): boolean => {
	if (seenDeliveries.has(id)) return false;
	seenDeliveries.add(id);
	if (seenDeliveries.size > MAX_SEEN_DELIVERIES) {
		// Sets iterate in insertion order: drop the oldest.
		const oldest = seenDeliveries.values().next().value;
		if (oldest !== undefined) seenDeliveries.delete(oldest);
	}
	return true;
};

const text = (body: string, status: number) =>
	new Response(body, { status, headers: { "Content-Type": "text/plain" } });

export const Route = createFileRoute("/api/hers/webhook")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const webhook = await readHersWebhook();
				if (!webhook) {
					return text("HERS webhook is not configured", 503);
				}

				// Verify against the raw body; re-serialized JSON would not match.
				const body = await request.text();
				let verified: VerifiedWebhook<HersWebhookEvent>;
				try {
					verified = await verifyWebhook<HersWebhookEvent>({
						secret: webhook.secret,
						headers: request.headers,
						body,
					});
				} catch (error) {
					if (error instanceof WebhookVerificationError) {
						return text(error.message, 400);
					}
					Logger.error({ msg: "HERS webhook verification failed", error });
					return text("Internal server error", 500);
				}

				const { id, event } = verified;
				if (!markSeen(id)) {
					return new Response(null, { status: 204 });
				}

				if (event.type === HERS_ANOMALY_EVENT) {
					// Acknowledge right away; classification calls back into HERS and
					// can outlast the sender's delivery timeout.
					void handleAnomalyDetected(event).catch((error) => {
						Logger.error({
							msg: "Failed to handle HERS anomaly event",
							deliveryId: id,
							error,
						});
					});
				} else {
					// Unknown to this SDK version; the type narrows to `never` here.
					const { type } = event as { type: string };
					Logger.log({ msg: "Ignoring HERS webhook event", type });
				}

				return new Response(null, { status: 204 });
			},
		},
	},
});
