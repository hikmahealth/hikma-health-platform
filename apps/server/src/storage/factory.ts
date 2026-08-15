import ServerVariable from "@/models/server_variable.ts";
import type { StorageAdapter, StorageConfig } from "./adapters/base.ts";
import { configFingerprint, resolveConfig } from "./adapters/base.ts";
import { createDiskAdapter, diskConfigFields } from "./adapters/disk.ts";
import {
  createS3Adapter,
  s3ConfigFields,
  tigrisConfigFields,
} from "./adapters/s3.ts";
import { createGCPAdapter, gcpConfigFields } from "./adapters/gcp.ts";
import { createAzureAdapter, azureConfigFields } from "./adapters/azure.ts";
import { ResourceStoreUnavailableError } from "./errors.ts";
import type { ConfigField, StoreType } from "./types.ts";
import { SUPPORTED_STORES, isStoreType } from "./types.ts";

/** The configuration fields a given backend reads. */
export const configFieldsFor = (store: StoreType): readonly ConfigField[] => {
  switch (store) {
    case "disk":
      return diskConfigFields;
    case "s3":
      return s3ConfigFields;
    case "tigris":
      return tigrisConfigFields;
    case "gcp":
      return gcpConfigFields;
    case "azure":
      return azureConfigFields;
  }
};

/**
 * Stores that read `key` as one of their secret fields. Removing a stored
 * credential is only safe when none of these is still in use, so the caller
 * needs the full set rather than just the active backend — see
 * `deleteStorageSecret`.
 *
 * An empty result means "no backend claims this key", which callers must treat
 * as a refusal, never as "nothing to protect". It is what a non-secret field
 * or an unrelated server variable returns.
 */
export const storesOwningSecret = (key: string): readonly StoreType[] =>
  SUPPORTED_STORES.filter((store) =>
    configFieldsFor(store).some(
      (field) => field.key === key && field.secret,
    ),
  );

const requireField = (config: StorageConfig, key: string): string => {
  const value = config[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required storage config field: ${key}`);
  }
  return value;
};

/**
 * Build an adapter from an already-resolved configuration. Exported so the
 * settings screen can probe a config that has not been saved yet; ordinary
 * callers want `getAdapterForStore`, which caches.
 */
export const createAdapter = async (
  store: StoreType,
  config: StorageConfig,
): Promise<StorageAdapter> => {
  switch (store) {
    case "disk":
      return createDiskAdapter(config.disk_storage_path);
    // S3 and Tigris read disjoint key sets on purpose — see the note above
    // `s3ConfigFields`. Do not collapse these two cases.
    case "s3":
      return createS3Adapter({
        storeName: "s3",
        accessKeyId: requireField(config, "aws_access_key_id"),
        secretAccessKey: requireField(config, "aws_secret_access_key"),
        region: requireField(config, "aws_region"),
        bucketName: requireField(config, "s3_bucket_name"),
      });
    case "tigris":
      return createS3Adapter({
        storeName: "tigris",
        accessKeyId: requireField(config, "tigris_access_key_id"),
        secretAccessKey: requireField(config, "tigris_secret_access_key"),
        region: requireField(config, "tigris_region"),
        bucketName: requireField(config, "tigris_bucket_name"),
        endpoint: requireField(config, "tigris_endpoint_url"),
      });
    case "gcp":
      return createGCPAdapter({
        serviceAccountJson: requireField(config, "gcp_service_account"),
        bucketName: requireField(config, "gcp_bucket_name"),
        location: config.gcp_bucket_location,
      });
    case "azure":
      return createAzureAdapter({
        connectionString: requireField(
          config,
          "azure_storage_connection_string",
        ),
        containerName: requireField(config, "azure_container_name"),
      });
  }
};

type CacheEntry = {
  readonly fingerprint: string;
  readonly adapter: StorageAdapter;
};

const adapterCache = new Map<StoreType, CacheEntry>();

/** Drop every cached adapter, so a save takes effect here immediately. */
export const invalidateAdapterCache = (): void => {
  adapterCache.clear();
};

/** Reads the `hh_store_type` server variable, defaulting to "disk" when unset. */
export const getConfiguredStoreType = async (): Promise<StoreType> => {
  const raw = await ServerVariable.getAsString(
    ServerVariable.Keys.HH_STORE_TYPE,
  );
  const value = raw ?? "disk";
  if (!isStoreType(value)) {
    throw new Error(`Unsupported storage type configured: "${value}"`);
  }
  return value;
};

/**
 * Adapter for a named backend, regardless of which one is currently active.
 *
 * Read paths resolve through this using the `store` recorded on the resource
 * row, so a file uploaded before the active backend changed is still served
 * from wherever it actually lives. Cached against a config fingerprint, so no
 * request pays for SDK construction.
 */
export const getAdapterForStore = async (
  store: StoreType,
): Promise<StorageAdapter> => {
  const fields = configFieldsFor(store);

  try {
    const stored = await ServerVariable.getManyAsStrings(
      fields.map((field) => field.key),
    );
    const fingerprint = configFingerprint(fields, stored);

    const cached = adapterCache.get(store);
    if (cached && cached.fingerprint === fingerprint) {
      return cached.adapter;
    }

    const adapter = await createAdapter(store, resolveConfig(fields, stored));
    adapterCache.set(store, { fingerprint, adapter });
    return adapter;
  } catch (error) {
    throw new ResourceStoreUnavailableError(store, error);
  }
};

/** Adapter for the currently-active backend. All new uploads go here. */
export const getConfiguredAdapter = async (): Promise<StorageAdapter> =>
  getAdapterForStore(await getConfiguredStoreType());
