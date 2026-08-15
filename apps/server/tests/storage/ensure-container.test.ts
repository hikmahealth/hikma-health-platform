/**
 * Provisioning behaviour for the three cloud adapters. These paths only
 * misbehave against a real provider holding a least-privilege credential, so
 * the SDKs are stubbed and the interesting responses replayed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const awsError = (status: number): Error =>
  Object.assign(new Error(`aws ${status}`), {
    $metadata: { httpStatusCode: status },
  });

const azureError = (status: number): Error =>
  Object.assign(new Error(`azure ${status}`), { statusCode: status });

const googleError = (status: number): Error =>
  Object.assign(new Error(`google ${status}`), { code: status });

const s3 = vi.hoisted(() => ({
  sent: [] as Array<{ name: string; input: Record<string, unknown> }>,
  respond: (_name: string): unknown => undefined,
}));

vi.mock("@aws-sdk/client-s3", () => {
  const command = (name: string) =>
    class {
      readonly commandName = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  return {
    S3Client: class {
      constructor(readonly config: Record<string, unknown>) {}
      async send(cmd: { commandName: string; input: Record<string, unknown> }) {
        s3.sent.push({ name: cmd.commandName, input: cmd.input });
        return s3.respond(cmd.commandName);
      }
    },
    HeadBucketCommand: command("HeadBucket"),
    CreateBucketCommand: command("CreateBucket"),
    PutObjectCommand: command("PutObject"),
    GetObjectCommand: command("GetObject"),
    DeleteObjectCommand: command("DeleteObject"),
  };
});

const gcs = vi.hoisted(() => ({
  exists: async (): Promise<[boolean]> => [true],
  create: async (_options?: unknown): Promise<void> => {},
  createCalls: [] as unknown[],
  metadata: {} as { md5Hash?: string },
}));

vi.mock("@google-cloud/storage", () => ({
  Storage: class {
    constructor(readonly options: Record<string, unknown>) {}
    bucket(_name: string) {
      return {
        exists: () => gcs.exists(),
        create: (options?: unknown) => {
          gcs.createCalls.push(options);
          return gcs.create(options);
        },
        file: () => ({
          save: async () => {},
          getMetadata: async () => [gcs.metadata],
        }),
      };
    }
  },
}));

const azure = vi.hoisted(() => ({
  createIfNotExists: async (): Promise<void> => {},
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: {
    fromConnectionString: () => ({
      getContainerClient: () => ({
        createIfNotExists: () => azure.createIfNotExists(),
        getBlockBlobClient: () => ({}),
      }),
    }),
  },
}));

const { createS3Adapter } = await import("@/storage/adapters/s3");
const { createGCPAdapter } = await import("@/storage/adapters/gcp");
const { createAzureAdapter } = await import("@/storage/adapters/azure");

const s3Config = {
  storeName: "s3" as const,
  accessKeyId: "key",
  secretAccessKey: "secret",
  region: "eu-west-1",
  bucketName: "hikma-files",
};

beforeEach(() => {
  s3.sent = [];
  s3.respond = () => undefined;
  gcs.exists = async () => [true];
  gcs.create = async () => {};
  gcs.createCalls = [];
  gcs.metadata = {};
  azure.createIfNotExists = async () => {};
});

describe("S3 ensureContainer", () => {
  it("does nothing more when the bucket heads successfully", async () => {
    const adapter = await createS3Adapter(s3Config);
    await adapter.ensureContainer();

    expect(s3.sent.map((call) => call.name)).toEqual(["HeadBucket"]);
  });

  it("accepts a 403 from HeadBucket as 'bucket present'", async () => {
    // A bucket-scoped IAM key cannot HeadBucket. Failing here would break
    // the first upload of every least-privilege deployment.
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(403);
      return undefined;
    };

    const adapter = await createS3Adapter(s3Config);
    await adapter.ensureContainer();

    expect(s3.sent.map((call) => call.name)).toEqual(["HeadBucket"]);
  });

  it("creates the bucket after a 404", async () => {
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(404);
      return undefined;
    };

    const adapter = await createS3Adapter(s3Config);
    await adapter.ensureContainer();

    expect(s3.sent.map((call) => call.name)).toEqual([
      "HeadBucket",
      "CreateBucket",
    ]);
  });

  it("sends a location constraint outside us-east-1", async () => {
    // Without this, CreateBucket fails with IllegalLocationConstraint in
    // every region but us-east-1.
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(404);
      return undefined;
    };

    const adapter = await createS3Adapter(s3Config);
    await adapter.ensureContainer();

    const create = s3.sent.find((call) => call.name === "CreateBucket");
    expect(create?.input.CreateBucketConfiguration).toEqual({
      LocationConstraint: "eu-west-1",
    });
  });

  it("omits the location constraint in us-east-1, which rejects one", async () => {
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(404);
      return undefined;
    };

    const adapter = await createS3Adapter({ ...s3Config, region: "us-east-1" });
    await adapter.ensureContainer();

    const create = s3.sent.find((call) => call.name === "CreateBucket");
    expect(create?.input.CreateBucketConfiguration).toBeUndefined();
  });

  it("omits the location constraint for Tigris, which routes globally", async () => {
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(404);
      return undefined;
    };

    const adapter = await createS3Adapter({
      ...s3Config,
      storeName: "tigris",
      region: "auto",
      endpoint: "https://t3.storage.dev",
    });
    await adapter.ensureContainer();

    const create = s3.sent.find((call) => call.name === "CreateBucket");
    expect(create?.input.CreateBucketConfiguration).toBeUndefined();
  });

  it("treats a 409 on create as another instance winning the race", async () => {
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(404);
      throw awsError(409);
    };

    const adapter = await createS3Adapter(s3Config);
    await expect(adapter.ensureContainer()).resolves.toBeUndefined();
  });

  it("explains a 403 on create rather than surfacing the raw SDK error", async () => {
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(404);
      throw awsError(403);
    };

    const adapter = await createS3Adapter(s3Config);
    await expect(adapter.ensureContainer()).rejects.toThrow(
      /not allowed to create it/,
    );
  });

  it("propagates an unrecognised HeadBucket failure", async () => {
    s3.respond = (name) => {
      if (name === "HeadBucket") throw awsError(500);
      return undefined;
    };

    const adapter = await createS3Adapter(s3Config);
    await expect(adapter.ensureContainer()).rejects.toThrow();
  });
});

describe("S3 endpoint validation", () => {
  it("rejects a loopback endpoint", async () => {
    await expect(
      createS3Adapter({
        ...s3Config,
        storeName: "tigris",
        endpoint: "https://127.0.0.1:9000",
      }),
    ).rejects.toThrow(/private or loopback/);
  });

  it("rejects the cloud instance-metadata address", async () => {
    await expect(
      createS3Adapter({
        ...s3Config,
        storeName: "tigris",
        endpoint: "https://169.254.169.254",
      }),
    ).rejects.toThrow(/private or loopback/);
  });

  it("rejects a plaintext endpoint outside development", async () => {
    await expect(
      createS3Adapter({
        ...s3Config,
        storeName: "tigris",
        endpoint: "http://storage.example.com",
      }),
    ).rejects.toThrow(/https/);
  });

  it("accepts the documented Tigris endpoint", async () => {
    await expect(
      createS3Adapter({
        ...s3Config,
        storeName: "tigris",
        endpoint: "https://t3.storage.dev",
      }),
    ).resolves.toHaveProperty("name", "tigris");
  });
});

describe("GCS ensureContainer", () => {
  const gcpConfig = {
    serviceAccountJson: JSON.stringify({ project_id: "hikma" }),
    bucketName: "hikma-files",
  };

  it("does nothing more when the bucket exists", async () => {
    const adapter = await createGCPAdapter(gcpConfig);
    await adapter.ensureContainer();

    expect(gcs.createCalls).toEqual([]);
  });

  it("accepts a 403 from exists() as 'bucket present'", async () => {
    // exists() only maps 404 to false, so a bucket-scoped service account
    // throws here even though the bucket is usable.
    gcs.exists = async () => {
      throw googleError(403);
    };

    const adapter = await createGCPAdapter(gcpConfig);
    await adapter.ensureContainer();

    expect(gcs.createCalls).toEqual([]);
  });

  it("creates the bucket when it genuinely does not exist", async () => {
    gcs.exists = async () => [false];

    const adapter = await createGCPAdapter(gcpConfig);
    await adapter.ensureContainer();

    expect(gcs.createCalls).toHaveLength(1);
  });

  it("passes the configured location so data residency is respected", async () => {
    gcs.exists = async () => [false];

    const adapter = await createGCPAdapter({ ...gcpConfig, location: "EU" });
    await adapter.ensureContainer();

    expect(gcs.createCalls[0]).toEqual({ location: "EU" });
  });

  it("explains a 403 on create", async () => {
    gcs.exists = async () => [false];
    gcs.create = async () => {
      throw googleError(403);
    };

    const adapter = await createGCPAdapter(gcpConfig);
    await expect(adapter.ensureContainer()).rejects.toThrow(
      /not allowed to create it/,
    );
  });

  it("reports no comparable digest when GCS omits md5Hash", async () => {
    // GCS is the only backend where a digest mismatch is fatal, and a
    // composite object carries no md5Hash. That must reach the "skipped"
    // branch, not the fatal one.
    const { verifyPutIntegrity } = await import("@/storage/integrity");
    const payload = new Uint8Array([1, 2, 3]);

    const adapter = await createGCPAdapter(gcpConfig);
    const output = await adapter.put(payload, "dest", "text/plain");

    expect(output.hash).toEqual(["none", ""]);
    expect(verifyPutIntegrity("gcp", output, payload).outcome).toBe("skipped");
  });

  it("reports a comparable digest when GCS returns md5Hash", async () => {
    const { verifyPutIntegrity } = await import("@/storage/integrity");
    const { createHash } = await import("node:crypto");
    const payload = new Uint8Array([1, 2, 3]);
    gcs.metadata = {
      md5Hash: createHash("md5").update(payload).digest("base64"),
    };

    const adapter = await createGCPAdapter(gcpConfig);
    const output = await adapter.put(payload, "dest", "text/plain");

    expect(verifyPutIntegrity("gcp", output, payload).outcome).toBe("match");
  });

  it("rejects service-account JSON that is not an object", async () => {
    await expect(
      createGCPAdapter({ ...gcpConfig, serviceAccountJson: "[]" }),
    ).rejects.toThrow(/must be a JSON object/);
  });

  it("rejects service-account JSON that does not parse", async () => {
    await expect(
      createGCPAdapter({ ...gcpConfig, serviceAccountJson: "not json" }),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe("Azure ensureContainer", () => {
  const azureConfig = {
    connectionString:
      "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=b;EndpointSuffix=core.windows.net",
    containerName: "hikmahealth",
  };

  it("creates the container when permitted", async () => {
    const adapter = await createAzureAdapter(azureConfig);
    await expect(adapter.ensureContainer()).resolves.toBeUndefined();
  });

  it("accepts a 403 as 'container present'", async () => {
    // A container-scoped SAS credential cannot create containers.
    azure.createIfNotExists = async () => {
      throw azureError(403);
    };

    const adapter = await createAzureAdapter(azureConfig);
    await expect(adapter.ensureContainer()).resolves.toBeUndefined();
  });

  it("propagates an authentication failure", async () => {
    azure.createIfNotExists = async () => {
      throw azureError(401);
    };

    const adapter = await createAzureAdapter(azureConfig);
    await expect(adapter.ensureContainer()).rejects.toThrow();
  });
});
