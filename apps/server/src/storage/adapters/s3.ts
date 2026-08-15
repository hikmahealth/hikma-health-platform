import type { BucketLocationConstraint } from "@aws-sdk/client-s3";
import type { StorageAdapter } from "./base.ts";
import { assertSafeEndpoint, httpStatusOf, validatePut } from "./base.ts";
import type { ConfigField, PutOutput } from "../types.ts";
import { ResourceOperationError } from "../errors.ts";

/** The S3 adapter serves both native AWS S3 and S3-compatible Tigris. */
export type S3StoreName = "s3" | "tigris";

export type S3AdapterConfig = {
  /**
   * Passed in rather than inferred from `endpoint`, so what lands in
   * `resources.store` never depends on which fields happen to be stored.
   */
  storeName: S3StoreName;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucketName: string;
  /** When set, points at an S3-compatible endpoint (e.g. Tigris) */
  endpoint?: string;
};

const TIGRIS_ENDPOINT = "https://t3.storage.dev";

/**
 * S3 and Tigris deliberately do NOT share configuration keys.
 *
 * They did once, and it meant saving one provider's credentials silently
 * overwrote the other's — so `getAdapterForStore("tigris")` would build a
 * client from AWS credentials and every `resources` row written under the
 * other backend became unreadable. Worse, the S3 adapter would then sign
 * Tigris credentials to `s3.amazonaws.com`, disclosing them to a third party.
 * Keep these two key sets disjoint; `tests/storage/factory-resolution.test.ts`
 * asserts it.
 */
export const s3ConfigFields: readonly ConfigField[] = [
  {
    key: "aws_access_key_id",
    label: "Access Key ID",
    required: true,
    secret: true,
    valueType: "string",
  },
  {
    key: "aws_secret_access_key",
    label: "Secret Access Key",
    required: true,
    secret: true,
    valueType: "string",
  },
  {
    key: "aws_region",
    label: "Region",
    description: "The AWS region the bucket lives in.",
    placeholder: "us-east-1",
    required: false,
    secret: false,
    valueType: "string",
    default: "us-east-1",
  },
  {
    key: "s3_bucket_name",
    label: "Bucket name",
    description:
      "The S3 bucket to store files in. Bucket names are globally unique across all of AWS, so this must be a name you own.",
    // No default: S3's namespace is global, so a shared one would collide
    // with a stranger's bucket or silently create one nobody expected.
    required: true,
    secret: false,
    valueType: "string",
  },
] as const;

export const tigrisConfigFields: readonly ConfigField[] = [
  {
    key: "tigris_access_key_id",
    label: "Access Key ID",
    required: true,
    secret: true,
    valueType: "string",
  },
  {
    key: "tigris_secret_access_key",
    label: "Secret Access Key",
    required: true,
    secret: true,
    valueType: "string",
  },
  {
    key: "tigris_region",
    label: "Region",
    description: 'Tigris routes globally; leave this as "auto".',
    placeholder: "auto",
    required: false,
    secret: false,
    valueType: "string",
    default: "auto",
  },
  {
    key: "tigris_bucket_name",
    label: "Bucket name",
    description: "The Tigris bucket to store files in.",
    required: true,
    secret: false,
    valueType: "string",
  },
  {
    key: "tigris_endpoint_url",
    label: "Endpoint URL",
    description: "The Tigris S3 endpoint. Only change this if instructed to.",
    placeholder: TIGRIS_ENDPOINT,
    required: true,
    secret: false,
    valueType: "string",
    default: TIGRIS_ENDPOINT,
  },
] as const;

/**
 * An ETag equals the object's MD5 only for a single-part, unencrypted upload.
 * Multipart ETags carry a "-<parts>" suffix, and SSE-KMS/SSE-C ETags are
 * unrelated to the content. Callers treat "none" as "no comparable digest".
 */
const etagHash = (etag: string | undefined): PutOutput["hash"] => {
  const value = (etag ?? "").replace(/"/g, "");
  if (value === "" || value.includes("-")) return ["none", ""] as const;
  return ["md5", value] as const;
};

export const createS3Adapter = async (
  config: S3AdapterConfig,
): Promise<StorageAdapter> => {
  // Dynamic import — only loads SDK when this adapter is actually used
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    CreateBucketCommand,
  } = await import("@aws-sdk/client-s3");

  const isTigris = config.storeName === "tigris";

  if (config.endpoint !== undefined) {
    assertSafeEndpoint(
      config.endpoint,
      process.env.NODE_ENV === "development",
    );
  }

  const client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint
      ? { endpoint: config.endpoint, forcePathStyle: false }
      : {}),
  });

  return {
    name: config.storeName,
    version: `s3.${isTigris ? "tigris" : "native"}.202603.01`,

    async ensureContainer(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucketName }));
        return;
      } catch (error) {
        const status = httpStatusOf(error);
        // A bucket-scoped credential is routinely denied HeadBucket even
        // though the bucket exists and is writable.
        if (status === 403) return;
        if (status !== 404) {
          throw new ResourceOperationError("ensureContainer", error);
        }
      }

      try {
        // Every region but us-east-1 requires a location constraint;
        // us-east-1 rejects one, and Tigris has no location to constrain.
        const needsLocation = !isTigris && config.region !== "us-east-1";
        await client.send(
          new CreateBucketCommand({
            Bucket: config.bucketName,
            ...(needsLocation
              ? {
                  CreateBucketConfiguration: {
                    LocationConstraint: config.region as BucketLocationConstraint,
                  },
                }
              : {}),
          }),
        );
      } catch (error) {
        const status = httpStatusOf(error);
        // 409 means another instance created it first.
        if (status === 409) return;
        if (status === 403) {
          throw new ResourceOperationError(
            "ensureContainer",
            new Error(
              `Bucket "${config.bucketName}" does not exist and this credential is not allowed to create it. Create the bucket first, or grant s3:CreateBucket.`,
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
        const response = await client.send(
          new PutObjectCommand({
            Bucket: config.bucketName,
            Key: destination,
            Body: data,
            ContentType: mimetype ?? "application/octet-stream",
          }),
        );
        return { uri: destination, hash: etagHash(response.ETag) };
      } catch (error) {
        throw new ResourceOperationError("put", error);
      }
    },

    async delete(uri: string): Promise<void> {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucketName,
            Key: uri,
          }),
        );
      } catch (error) {
        throw new ResourceOperationError("delete", error);
      }
    },

    async downloadAsBytes(uri: string): Promise<Uint8Array> {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucketName,
            Key: uri,
          }),
        );
        const stream = response.Body;
        if (!stream) throw new Error("Empty response body from S3");
        return new Uint8Array(await stream.transformToByteArray());
      } catch (error) {
        throw new ResourceOperationError("downloadAsBytes", error);
      }
    },
  };
};
