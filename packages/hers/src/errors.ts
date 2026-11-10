/** Base class for all errors thrown by the HERS SDK. */
export class HersError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HersError";
  }
}

/** A non-2xx response from the HERS API. */
export class HersApiError extends HersError {
  readonly status: number;
  /** Parsed JSON for `400` responses, raw text otherwise. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(`HERS API ${status}: ${message}`);
    this.name = "HersApiError";
    this.status = status;
    this.body = body;
  }
}

/** `400`: the request failed validation. */
export class HersValidationError extends HersApiError {
  readonly error: unknown;

  constructor(body: { success: false; error: unknown } | unknown) {
    super(400, "request failed validation", body);
    this.name = "HersValidationError";
    this.error =
      body && typeof body === "object" && "error" in body
        ? (body as { error: unknown }).error
        : body;
  }
}

/** `401`: missing, malformed, invalid or expired credentials. */
export class HersAuthenticationError extends HersApiError {
  constructor(message: string) {
    super(401, message, message);
    this.name = "HersAuthenticationError";
  }
}

/** `403`: the client lacks the scope the route needs. */
export class HersForbiddenError extends HersApiError {
  constructor(message: string) {
    super(403, message, message);
    this.name = "HersForbiddenError";
  }
}

/** `404`: unknown location reference. */
export class HersNotFoundError extends HersApiError {
  constructor(message: string) {
    super(404, message, message);
    this.name = "HersNotFoundError";
  }
}

/** Builds the appropriate error for a non-2xx response. */
export async function errorFromResponse(res: Response): Promise<HersApiError> {
  const text = await res.text().catch(() => "");

  switch (res.status) {
    case 400: {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // keep raw text
      }
      return new HersValidationError(body);
    }
    case 401:
      return new HersAuthenticationError(text || "unauthorized");
    case 403:
      return new HersForbiddenError(text || "forbidden");
    case 404:
      return new HersNotFoundError(text || "not found");
    default:
      return new HersApiError(res.status, text || res.statusText, text);
  }
}
