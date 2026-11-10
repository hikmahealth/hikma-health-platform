export { HersClient } from "./client.js";
export type {
  CreateClientOptions,
  FetchLike,
  HersClientOptions,
  RequestOptions,
} from "./client.js";

export {
  createTokenProvider,
  importSigningKey,
  MAX_TOKEN_TTL_SECONDS,
  signToken,
} from "./auth.js";
export type {
  CachedTokenProviderOptions,
  ClientCredentials,
  SignTokenOptions,
  TokenProvider,
} from "./auth.js";

export { HERS_CLIENT_ID, HERS_CLIENT_URL } from "./env.js";

export {
  HersApiError,
  HersAuthenticationError,
  HersError,
  HersForbiddenError,
  HersNotFoundError,
  HersValidationError,
} from "./errors.js";

export {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  signWebhookPayload,
  verifyWebhook,
  WebhookVerificationError,
} from "./webhooks.js";
export type {
  VerifiedWebhook,
  VerifyWebhookOptions,
  WebhookHeaders,
} from "./webhooks.js";

export type * from "./types.js";
