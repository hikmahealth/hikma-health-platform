import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { putVerified, verifyPutIntegrity } from "@/storage/integrity";
import type { StorageAdapter } from "@/storage/adapters/base";
import type { PutOutput, StoreType } from "@/storage/types";

const payload = new Uint8Array([1, 2, 3, 4]);
const payloadMd5 = createHash("md5").update(payload).digest("hex");

const stubAdapter = (
  name: StoreType,
  output: PutOutput,
): StorageAdapter & { deleted: string[] } => {
  const deleted: string[] = [];
  return {
    name,
    version: `${name}.test`,
    deleted,
    put: vi.fn(async () => output),
    delete: vi.fn(async (uri: string) => {
      deleted.push(uri);
    }),
    downloadAsBytes: vi.fn(async () => payload),
    ensureContainer: vi.fn(async () => {}),
  };
};

describe("verifyPutIntegrity", () => {
  it("matches when the provider digest equals the sent bytes", () => {
    const verdict = verifyPutIntegrity(
      "disk",
      { uri: "a", hash: ["md5", payloadMd5] },
      payload,
    );
    expect(verdict.outcome).toBe("match");
  });

  it("skips when the provider returned no comparable digest", () => {
    const verdict = verifyPutIntegrity(
      "tigris",
      { uri: "a", hash: ["none", ""] },
      payload,
    );
    expect(verdict.outcome).toBe("skipped");
  });

  it("accepts an uppercase digest", () => {
    const verdict = verifyPutIntegrity(
      "gcp",
      { uri: "a", hash: ["md5", payloadMd5.toUpperCase()] },
      payload,
    );
    expect(verdict.outcome).toBe("match");
  });

  it("is fatal on GCS, where md5Hash is definitionally the object digest", () => {
    const verdict = verifyPutIntegrity(
      "gcp",
      { uri: "a", hash: ["md5", "00000000000000000000000000000000"] },
      payload,
    );
    expect(verdict).toMatchObject({ outcome: "mismatch", fatal: true });
  });

  it("is non-fatal on S3, where an ETag need not be the content MD5", () => {
    // An SSE-KMS or multipart ETag is unrelated to the content, so failing
    // closed here would break a correct upload.
    const verdict = verifyPutIntegrity(
      "s3",
      { uri: "a", hash: ["md5", "00000000000000000000000000000000"] },
      payload,
    );
    expect(verdict).toMatchObject({ outcome: "mismatch", fatal: false });
  });

  it("is non-fatal on Tigris", () => {
    const verdict = verifyPutIntegrity(
      "tigris",
      { uri: "a", hash: ["md5", "00000000000000000000000000000000"] },
      payload,
    );
    expect(verdict).toMatchObject({ outcome: "mismatch", fatal: false });
  });
});

describe("putVerified", () => {
  it("returns the put output when the digest matches", async () => {
    const adapter = stubAdapter("disk", {
      uri: "dest",
      hash: ["md5", payloadMd5],
    });

    const output = await putVerified(adapter, payload, "dest", "text/plain");

    expect(output.uri).toBe("dest");
    expect(adapter.deleted).toEqual([]);
  });

  it("removes the object and throws on a fatal mismatch", async () => {
    const adapter = stubAdapter("gcp", {
      uri: "dest",
      hash: ["md5", "00000000000000000000000000000000"],
    });

    await expect(
      putVerified(adapter, payload, "dest", "text/plain"),
    ).rejects.toThrow(/does not match/);
    expect(adapter.deleted).toEqual(["dest"]);
  });

  it("keeps the upload on a non-fatal mismatch", async () => {
    const adapter = stubAdapter("tigris", {
      uri: "dest",
      hash: ["md5", "00000000000000000000000000000000"],
    });

    const output = await putVerified(adapter, payload, "dest", "text/plain");

    expect(output.uri).toBe("dest");
    expect(adapter.deleted).toEqual([]);
  });
});
