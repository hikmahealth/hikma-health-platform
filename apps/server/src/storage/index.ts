export type { StorageAdapter, StorageConfig } from "./adapters/base.ts";
export {
  configFingerprint,
  resolveConfig,
  validatePut,
} from "./adapters/base.ts";
export type {
  StoreType,
  PutOutput,
  ConfigField,
  StoreDescriptor,
} from "./types.ts";
export {
  SUPPORTED_STORES,
  STORE_DESCRIPTORS,
  isStoreType,
  UPLOAD_SIZE_LIMIT_BYTES,
  ALLOWED_MIMETYPES,
  isAllowedMimetype,
  RESOURCE_PATH_PREFIX,
  EDUCATION_RESOURCE_PATH_PREFIX,
  sanitizeFilename,
} from "./types.ts";
export * from "./errors.ts";
export type { IntegrityVerdict } from "./integrity.ts";
export { verifyPutIntegrity, putVerified } from "./integrity.ts";
export {
  configFieldsFor,
  createAdapter,
  getAdapterForStore,
  getConfiguredAdapter,
  getConfiguredStoreType,
  invalidateAdapterCache,
} from "./factory.ts";

// Adapter config definitions — importable without loading any cloud SDK
export { diskConfigFields } from "./adapters/disk.ts";
export { s3ConfigFields, tigrisConfigFields } from "./adapters/s3.ts";
export { gcpConfigFields } from "./adapters/gcp.ts";
export { azureConfigFields } from "./adapters/azure.ts";
