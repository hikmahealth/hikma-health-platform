import {
  createTokenProvider,
  type CachedTokenProviderOptions,
  type ClientCredentials,
  type TokenProvider,
} from "./auth.js";
import { HERS_CLIENT_ID, HERS_CLIENT_URL, readEnv } from "./env.js";
import { errorFromResponse, HersError } from "./errors.js";
import type {
  ClassifyPatient,
  ClassifyResponse,
  CreateClientRequest,
  CreateClientResponse,
  ListSubscriptionsQuery,
  LocationSubscription,
  RegisterWebhookRequest,
  RegisterWebhookResponse,
  StatusResponse,
  SubscribeRequest,
  SubscribeResponse,
  UnsubscribeRequest,
  UnsubscribeResponse,
} from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface BaseOptions {
  /**
   * Server origin (optionally with a path prefix), e.g. `https://hers.example.com`.
   * `/v1` is appended. Defaults to the `HERS_CLIENT_URL` environment variable.
   */
  baseUrl?: string;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

export type HersClientOptions = BaseOptions &
  (
    | {
        /**
         * Client id and signing key. Tokens are signed and cached automatically.
         * `clientId` falls back to the `HERS_CLIENT_ID` environment variable.
         */
        credentials: Pick<ClientCredentials, "signingKey"> &
          Partial<Pick<ClientCredentials, "clientId">>;
        tokenOptions?: CachedTokenProviderOptions;
        getToken?: never;
      }
    | {
        /** Supply your own bearer tokens, e.g. when signing happens elsewhere. */
        getToken: TokenProvider;
        credentials?: never;
        tokenOptions?: never;
      }
  );

export interface RequestOptions {
  signal?: AbortSignal;
}

export type CreateClientOptions = BaseOptions & RequestOptions;

interface InternalRequest extends RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  token?: string;
}

interface ResolvedBase {
  baseUrl: string;
  fetch: FetchLike;
  headers?: Record<string, string>;
}

function resolveBaseUrl(baseUrl?: string): string {
  const url = baseUrl ?? readEnv(HERS_CLIENT_URL);
  if (!url) {
    throw new HersError(
      `missing HERS base URL: pass \`baseUrl\` or set the ${HERS_CLIENT_URL} environment variable`,
    );
  }
  return url.replace(/\/+$/, "");
}

function resolveCredentials(
  credentials: Partial<ClientCredentials> = {},
): ClientCredentials {
  const clientId = credentials.clientId ?? readEnv(HERS_CLIENT_ID);
  const signingKey = credentials.signingKey;

  if (!clientId) {
    throw new HersError(
      `missing HERS client id: pass \`credentials.clientId\` or set the ${HERS_CLIENT_ID} environment variable`,
    );
  }
  if (!signingKey) {
    throw new HersError(
      "missing HERS signing key: pass `credentials.signingKey`",
    );
  }

  return { clientId, signingKey };
}

async function send<T>(base: ResolvedBase, req: InternalRequest): Promise<T> {
  let url = `${base.baseUrl}/v1${req.path}`;
  if (req.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined) params.set(k, v);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...base.headers,
  };
  if (req.body !== undefined) headers["content-type"] = "application/json";
  if (req.token) headers["authorization"] = `Bearer ${req.token}`;

  let res: Response;
  try {
    res = await base.fetch(url, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: req.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new HersError(`request to ${req.method} ${url} failed`, { cause });
  }

  if (!res.ok) {
    throw await errorFromResponse(res);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new HersError(`invalid JSON in response from ${req.method} ${url}`, {
      cause,
    });
  }
}

function resolveFetch(custom?: FetchLike): FetchLike {
  return custom ?? ((input, init) => fetch(input, init));
}

/**
 * Client for the HERS API.
 *
 * ```ts
 * // baseUrl and clientId fall back to HERS_CLIENT_URL and HERS_CLIENT_ID.
 * const hers = new HersClient({ credentials: { signingKey } });
 *
 * // Or pass everything explicitly.
 * const hers = new HersClient({
 *   baseUrl: "https://hers.example.com",
 *   credentials: { clientId, signingKey },
 * });
 * const { client } = await hers.status();
 * ```
 */
export class HersClient {
  /**
   * Creates a new client and returns its id and signing key. Unauthenticated;
   * meant for provisioning. The signing key is returned only once.
   */
  static createClient(
    body: CreateClientRequest = {},
    options: CreateClientOptions = {},
  ): Promise<CreateClientResponse> {
    return send<CreateClientResponse>(
      {
        baseUrl: resolveBaseUrl(options.baseUrl),
        fetch: resolveFetch(options.fetch),
        headers: options.headers,
      },
      { method: "POST", path: "/client/create", body, signal: options.signal },
    );
  }

  readonly ems: {
    /** Lists monitored locations and the features watched at each. Requires `ems` scope. */
    listSubscriptions(
      query?: ListSubscriptionsQuery,
      options?: RequestOptions,
    ): Promise<LocationSubscription[]>;
    /** Registers or updates locations to monitor. Requires `ems` scope. */
    subscribe(
      body: SubscribeRequest,
      options?: RequestOptions,
    ): Promise<SubscribeResponse>;
    /** Stops all monitoring at the given locations. Requires `ems` scope. */
    unsubscribe(
      body: UnsubscribeRequest,
      options?: RequestOptions,
    ): Promise<UnsubscribeResponse>;
  };

  readonly hers: {
    /**
     * Predicts environmental health risk for patients at a registered location.
     * Results are returned in request order. Requires `hers` scope.
     */
    classify(
      location: string,
      patients: ClassifyPatient[],
      options?: RequestOptions,
    ): Promise<ClassifyResponse>;
  };

  readonly #base: ResolvedBase;
  readonly #getToken: TokenProvider;

  constructor(options: HersClientOptions) {
    this.#base = {
      baseUrl: resolveBaseUrl(options.baseUrl),
      fetch: resolveFetch(options.fetch),
      headers: options.headers,
    };

    this.#getToken = options.getToken
      ? options.getToken
      : createTokenProvider(
          resolveCredentials(options.credentials),
          options.tokenOptions,
        );

    this.ems = {
      listSubscriptions: (query = {}, opts) =>
        this.#request({
          method: "GET",
          path: "/api/ems/subscription",
          query: { location: query.location },
          ...opts,
        }),
      subscribe: (body, opts) =>
        this.#request({
          method: "POST",
          path: "/api/ems/subscription",
          body,
          ...opts,
        }),
      unsubscribe: (body, opts) =>
        this.#request({
          method: "DELETE",
          path: "/api/ems/subscription",
          body,
          ...opts,
        }),
    };

    this.hers = {
      classify: (location, patients, opts) =>
        this.#request({
          method: "POST",
          path: "/api/hers/classify",
          query: { location },
          body: patients,
          ...opts,
        }),
    };
  }

  /** Returns details about the authenticated client. Useful to check credentials. */
  status(options?: RequestOptions): Promise<StatusResponse> {
    return this.#request({ method: "GET", path: "/api/status", ...options });
  }

  /**
   * Registers a webhook URL. Registering the same URL again replaces its events
   * and rotates its secret. The secret is returned only once.
   */
  registerWebhook(
    body: RegisterWebhookRequest,
    options?: RequestOptions,
  ): Promise<RegisterWebhookResponse> {
    return this.#request({
      method: "POST",
      path: "/api/webhooks",
      body,
      ...options,
    });
  }

  async #request<T>(req: Omit<InternalRequest, "token">): Promise<T> {
    const token = await this.#getToken();
    return send<T>(this.#base, { ...req, token });
  }
}
