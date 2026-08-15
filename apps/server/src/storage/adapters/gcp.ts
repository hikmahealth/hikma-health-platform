import type { StorageAdapter } from "./base.ts";
import { httpStatusOf, validatePut } from "./base.ts";
import type { ConfigField, PutOutput } from "../types.ts";
import { ResourceOperationError } from "../errors.ts";

export type GCPAdapterConfig = {
  /** Raw service-account JSON, as pasted into the settings screen. */
  serviceAccountJson: string;
  bucketName: string;
  /** Applied only when the bucket has to be created. */
  location?: string;
};

export const gcpConfigFields: readonly ConfigField[] = [
  {
    key: "gcp_service_account",
    label: "Service account JSON",
    description:
      "The full service-account key file, with the Storage Object Admin role on the bucket.",
    required: true,
    secret: true,
    valueType: "json",
  },
  {
    key: "gcp_bucket_name",
    label: "Bucket name",
    description:
      "The Cloud Storage bucket to store files in. Bucket names are globally unique across all of Google Cloud, so this must be a name you own.",
    // No default, for the same reason as S3: the namespace is global.
    required: true,
    secret: false,
    valueType: "string",
  },
  {
    key: "gcp_bucket_location",
    label: "Bucket location",
    description:
      "Only used when creating the bucket, e.g. \"US\", \"EU\" or \"europe-west1\". Set this where patient data must stay in a given jurisdiction. Google defaults to a US multi-region.",
    placeholder: "US",
    required: false,
    secret: false,
    valueType: "string",
  },
] as const;

const parseServiceAccount = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("gcp_service_account is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("gcp_service_account must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

export const createGCPAdapter = async (
  config: GCPAdapterConfig,
): Promise<StorageAdapter> => {
  const { Storage } = await import("@google-cloud/storage");

  const storage = new Storage({
    credentials: parseServiceAccount(config.serviceAccountJson),
  });

  const bucket = storage.bucket(config.bucketName);

  return {
    name: "gcp",
    version: "gcp.202603.01",

    async ensureContainer(): Promise<void> {
      try {
        const [exists] = await bucket.exists();
        if (exists) return;
      } catch (error) {
        // exists() maps only 404 to false, so a bucket-scoped service account
        // denied the metadata read throws 403 on a perfectly usable bucket.
        if (httpStatusOf(error) === 403) return;
        throw new ResourceOperationError("ensureContainer", error);
      }

      try {
        await bucket.create(
          config.location ? { location: config.location } : undefined,
        );
      } catch (error) {
        const status = httpStatusOf(error);
        // 409 means another instance created it first.
        if (status === 409) return;
        if (status === 403) {
          throw new ResourceOperationError(
            "ensureContainer",
            new Error(
              `Bucket "${config.bucketName}" does not exist and this service account is not allowed to create it. Create the bucket first, or grant the Storage Admin role.`,
            ),
          );
        }
        throw new ResourceOperationError("ensureContainer", error);
      }
    },

    async put(
      data: Uint8Array,
      destination: string,
      mimetype?: string,
    ): Promise<PutOutput> {
      validatePut(data, mimetype);
      try {
        const file = bucket.file(destination);
        await file.save(Buffer.from(data), {
          contentType: mimetype ?? "application/octet-stream",
          validation: "md5",
        });
        const [metadata] = await file.getMetadata();
        const md5 = metadata.md5Hash
          ? Buffer.from(metadata.md5Hash, "base64").toString("hex")
          : "";
        return {
          uri: destination,
          hash: md5 === "" ? (["none", ""] as const) : (["md5", md5] as const),
        };
      } catch (error) {
        throw new ResourceOperationError("put", error);
      }
    },

    async delete(uri: string): Promise<void> {
      try {
        await bucket.file(uri).delete({ ignoreNotFound: true });
      } catch (error) {
        throw new ResourceOperationError("delete", error);
      }
    },

    async downloadAsBytes(uri: string): Promise<Uint8Array> {
      try {
        const [contents] = await bucket.file(uri).download();
        return new Uint8Array(contents);
      } catch (error) {
        throw new ResourceOperationError("downloadAsBytes", error);
      }
    },
  };
};
