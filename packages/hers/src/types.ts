/** ISO 8601 timestamp string, e.g. `2026-11-04T10:00:00.000Z`. */
export type IsoTimestamp = string;

export type Scope = "hers" | "ems" | (string & {});

export type ClientStatus = "active" | "disabled";

/** Environmental feature that can be monitored at a location. */
export type Feature = "temperature" | "pm_2_5";

// ---------------------------------------------------------------------------
// POST /v1/client/create
// ---------------------------------------------------------------------------

export interface CreateClientRequest {
  name?: string | null;
  description?: string | null;
}

export interface CreateClientResponse {
  client_id: string;
  client_signing_key: {
    /** Base64-encoded PKCS#8 DER Ed25519 private key. Returned only once. */
    base64_encoded: string;
  };
}

// ---------------------------------------------------------------------------
// GET /v1/api/status
// ---------------------------------------------------------------------------

export interface ClientDetails {
  id: string;
  name: string | null;
  description: string | null;
  scope: Scope[];
  status: ClientStatus;
  created_at: IsoTimestamp;
}

export interface StatusResponse {
  ok: true;
  client: ClientDetails;
}

// ---------------------------------------------------------------------------
// POST /v1/api/webhooks
// ---------------------------------------------------------------------------

export type WebhookEventType = "environment.anomaly_detected" | (string & {});

export interface RegisterWebhookRequest {
  /** At least one event type. */
  events: [WebhookEventType, ...WebhookEventType[]] | WebhookEventType[];
  /** `http` or `https` URL. */
  webhookUrl: string;
  description?: string | null;
  metadata?: Record<string, string | number | boolean> | null;
}

export interface RegisterWebhookResponse {
  id: string;
  events: WebhookEventType[];
  /** `whsec_...` secret used to verify signatures. Returned only once. */
  secret: string;
}

// ---------------------------------------------------------------------------
// /v1/api/ems/subscription
// ---------------------------------------------------------------------------

export interface ListSubscriptionsQuery {
  /** Filter by location reference. */
  location?: string;
}

export interface LocationSubscription {
  reference: string;
  /** `null` when the location is known but nothing is monitored there. */
  features: Feature[] | null;
}

/** Duration string like `"30m"`, `"4h"`, `"1d"`, `"2w"`. */
export type DurationString = `${number}${"m" | "h" | "d" | "w"}`;

export interface SubscriptionLocation {
  /** Your identifier for the location. Used as the location reference elsewhere. */
  key: string;
  latitude: number;
  longitude: number;
}

export interface SubscribeRequest {
  /** At least one feature. */
  features: Feature[];
  /**
   * How long to monitor: a duration string or a number of seconds.
   * Omit or `null` to monitor indefinitely.
   */
  duration?: DurationString | string | number | null;
  metadata: {
    /** Days ahead to check forecasts for (1–7). */
    forecast_days: number;
    [key: string]: unknown;
  };
  /** At least one location. */
  locations: SubscriptionLocation[];
}

export interface SubscribeResponse {
  ok: true;
}

export interface UnsubscribeRequest {
  /** At least one location reference. */
  location_references: string[];
}

export interface UnsubscribeResponse {
  ok: true;
  /** Number of feature configurations deleted. */
  removed: number;
}

// ---------------------------------------------------------------------------
// POST /v1/api/hers/classify
// ---------------------------------------------------------------------------

export type Sex = "male" | "female";

export interface ClassifyPatient {
  /** Your patient identifier, echoed back. */
  id: string;
  sex?: Sex | null;
  age_in_days?: number | null;
}

export type RiskScore = "low" | "medium" | "high";

export type RiskType = "cvd_risk" | "respiratory_risk" | (string & {});

export interface ClassifyResult {
  id: string;
  /** `null` when the risk couldn't be determined. */
  result: {
    score: RiskScore;
    type: RiskType;
  } | null;
}

export type ClassifyResponse = ClassifyResult[];

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------

export interface WebhookEvent<TType extends string = string, TData = unknown> {
  type: TType;
  /** When the event occurred. */
  timestamp: IsoTimestamp;
  data: TData;
}

export interface Anomaly {
  feature: Feature;
  unit: string | null;
  reason: string;
  /** Number of abnormal hourly readings. */
  count: number;
  first_at: IsoTimestamp;
  last_at: IsoTimestamp;
  peak: {
    time: IsoTimestamp;
    value: number;
  };
}

export interface AnomalyDetectedData {
  configuration_id: string;
  location: {
    /** Server-side location id. */
    id: string;
    /** Your location `key`. */
    reference: string | null;
    latitude: number;
    longitude: number;
  };
  forecast: {
    days: number;
    checked_at: IsoTimestamp;
  };
  anomalies: Anomaly[];
}

export type AnomalyDetectedEvent = WebhookEvent<
  "environment.anomaly_detected",
  AnomalyDetectedData
>;

/** Union of all known HERS webhook events. */
export type HersWebhookEvent = AnomalyDetectedEvent;
