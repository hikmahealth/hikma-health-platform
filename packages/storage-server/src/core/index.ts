export interface StoreManager {
  downloadAsBytes(path: string): Promise<Uint8Array>;
  put(data: Uint8Array, path: string, mimetype?: string): Promise<void>;
  delete(path: string): Promise<void>;
}

class StoreError extends Error {
  constructor(message?: string) {
    super(message ?? "unknown storage error");
    this.name = "StoreError";
  }
}

export class ResourceNotFoundError extends StoreError {
  constructor(path: string) {
    super(`resource not found: ${path}`);
    this.name = "ResourceNotFoundError";
  }
}

export class UnsupportedFileError extends StoreError {
  constructor(message?: string) {
    super(message);
    this.name = "UnsupportedFileError";
  }
}

export class UnsupportedMimeTypeError extends UnsupportedFileError {
  readonly mimetype: string;
  constructor(mimetype: string) {
    super(`unsupported mimetype: ${mimetype}`);
    this.name = "UnsupportedMimeTypeError";
    this.mimetype = mimetype;
  }
}
