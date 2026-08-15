export class ResourceManagerInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceManagerInitError";
  }
}

export class ResourceNotFoundError extends Error {
  constructor(resourceId: string) {
    super(`Resource not found: ${resourceId}`);
    this.name = "ResourceNotFoundError";
  }
}

export class ResourceStoreTypeMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `Resource was stored with "${actual}" but active adapter is "${expected}"`,
    );
    this.name = "ResourceStoreTypeMismatchError";
  }
}

/**
 * The backend a resource lives in cannot be reached: config missing, or the
 * SDK failed to initialise. The row is fine; the server is not.
 */
export class ResourceStoreUnavailableError extends Error {
  readonly store: string;

  constructor(store: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Storage backend "${store}" is unavailable${detail}`);
    this.name = "ResourceStoreUnavailableError";
    this.store = store;
    this.cause = cause;
  }
}

export class ResourceOperationError extends Error {
  constructor(operation: string, cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Storage operation "${operation}" failed${detail}`);
    this.name = "ResourceOperationError";
    this.cause = cause;
  }
}
