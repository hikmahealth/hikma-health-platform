export const SUPPORTED_STORES = [
  "s3",
  "tigris",
  "gcp",
  "azure",
  "disk",
] as const;
export type StoreType = (typeof SUPPORTED_STORES)[number];

export const isStoreType = (value: string): value is StoreType =>
  (SUPPORTED_STORES as readonly string[]).includes(value);

/** Returned by every adapter after a successful upload */
export type PutOutput = {
  readonly uri: string;
  readonly hash: readonly [algorithm: string, digest: string];
};

/**
 * The settings screen is generated from these, so adding a backend means
 * adding an adapter and a factory case — the UI needs no change.
 */
export type ConfigField = {
  readonly key: string;
  readonly required: boolean;
  /** If true, the value is never sent to a client — only an "is set" flag */
  readonly secret: boolean;
  readonly valueType: "string" | "json";
  readonly default?: string;
  readonly label: string;
  readonly description?: string;
  readonly placeholder?: string;
};

/** Presentation metadata for one storage backend, used by the settings screen. */
export type StoreDescriptor = {
  readonly store: StoreType;
  readonly label: string;
  readonly description: string;
};

export const STORE_DESCRIPTORS: readonly StoreDescriptor[] = [
  {
    store: "disk",
    label: "Local disk",
    description:
      "Files are written to the server's own filesystem. No external account needed, but storage is limited to the server's disk and is lost if the server is replaced.",
  },
  {
    store: "tigris",
    label: "Tigris",
    description:
      "S3-compatible global object storage. Create a bucket and an access key at console.storage.dev.",
  },
  {
    store: "s3",
    label: "Amazon S3",
    description:
      "Amazon Web Services object storage. Requires an IAM access key with read and write access to the bucket.",
  },
  {
    store: "gcp",
    label: "Google Cloud Storage",
    description:
      "Google Cloud object storage. Requires a service-account JSON key with the Storage Object Admin role.",
  },
  {
    store: "azure",
    label: "Azure Blob Storage",
    description:
      "Microsoft Azure blob storage. Requires a storage-account connection string.",
  },
] as const;

/** Max upload size in bytes (50 MB) */
export const UPLOAD_SIZE_LIMIT_BYTES = 50 * 1024 * 1024;

/** Mimetypes accepted for resource uploads */
export const ALLOWED_MIMETYPES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "text/plain",
  "text/csv",
  // Audio/video (clinical recordings)
  "audio/mpeg",
  "audio/ogg",
  "video/mp4",
  // Generic binary (e.g. DICOM, HL7 exports)
  "application/octet-stream",
]);

export const isAllowedMimetype = (mimetype: string): boolean =>
  ALLOWED_MIMETYPES.has(mimetype);

/** Default path prefix for form resource uploads */
export const RESOURCE_PATH_PREFIX = "hh_forms_resources";

/** Default path prefix for education content resource uploads */
export const EDUCATION_RESOURCE_PATH_PREFIX = "hh_education_resources";

/**
 * Make a client-supplied filename safe to embed in a storage key. Object
 * stores treat a key as opaque, so "../" is not a traversal there — but it is
 * on disk, and it makes keys unreadable everywhere.
 */
export const sanitizeFilename = (name: string): string => {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned === "" ? "file" : cleaned;
};
