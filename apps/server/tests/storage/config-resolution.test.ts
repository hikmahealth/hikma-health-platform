import { describe, expect, it } from "vitest";
import {
  assertSafeEndpoint,
  configFingerprint,
  httpStatusOf,
  resolveConfig,
} from "@/storage/adapters/base";
import type { ConfigField } from "@/storage/types";

const fields: readonly ConfigField[] = [
  {
    key: "aws_access_key_id",
    label: "Access Key ID",
    required: true,
    secret: true,
    valueType: "string",
  },
  {
    key: "aws_region",
    label: "Region",
    required: false,
    secret: false,
    valueType: "string",
    default: "auto",
  },
  {
    key: "s3_bucket_name",
    label: "Bucket name",
    required: true,
    secret: false,
    valueType: "string",
  },
];

describe("resolveConfig", () => {
  it("falls back to the stored value when no override is supplied", () => {
    const config = resolveConfig(fields, {
      aws_access_key_id: "stored-key",
      aws_region: null,
      s3_bucket_name: "stored-bucket",
    });

    expect(config.aws_access_key_id).toBe("stored-key");
    expect(config.s3_bucket_name).toBe("stored-bucket");
  });

  it("applies the field default when neither override nor stored value exists", () => {
    const config = resolveConfig(fields, {
      aws_access_key_id: "stored-key",
      aws_region: null,
      s3_bucket_name: "stored-bucket",
    });

    expect(config.aws_region).toBe("auto");
  });

  it("prefers an override over the stored value", () => {
    const config = resolveConfig(
      fields,
      { aws_access_key_id: "stored-key", s3_bucket_name: "stored-bucket" },
      { s3_bucket_name: "new-bucket" },
    );

    expect(config.s3_bucket_name).toBe("new-bucket");
  });

  it("treats a blank override as 'leave the stored value alone'", () => {
    // This is what an untouched secret input submits.
    const config = resolveConfig(
      fields,
      { aws_access_key_id: "stored-key", s3_bucket_name: "stored-bucket" },
      { aws_access_key_id: "" },
    );

    expect(config.aws_access_key_id).toBe("stored-key");
  });

  it("throws when a required field has no value from any source", () => {
    expect(() =>
      resolveConfig(fields, { aws_access_key_id: "stored-key" }),
    ).toThrow(/s3_bucket_name/);
  });

  it("treats a stored empty string as absent", () => {
    expect(() =>
      resolveConfig(fields, {
        aws_access_key_id: "stored-key",
        s3_bucket_name: "",
      }),
    ).toThrow(/s3_bucket_name/);
  });

  it("omits an optional field with no value rather than storing undefined", () => {
    const optional: readonly ConfigField[] = [
      {
        key: "aws_endpoint_url_s3",
        label: "Endpoint",
        required: false,
        secret: false,
        valueType: "string",
      },
    ];

    expect(resolveConfig(optional, {})).toEqual({});
  });
});

describe("configFingerprint", () => {
  it("is stable across key insertion order", () => {
    const left = configFingerprint(fields, {
      aws_access_key_id: "a",
      aws_region: "auto",
      s3_bucket_name: "b",
    });
    const right = configFingerprint(fields, {
      s3_bucket_name: "b",
      aws_access_key_id: "a",
      aws_region: "auto",
    });

    expect(left).toBe(right);
  });

  it("changes when any tracked value changes", () => {
    const before = configFingerprint(fields, {
      aws_access_key_id: "a",
      s3_bucket_name: "b",
    });
    const after = configFingerprint(fields, {
      aws_access_key_id: "a",
      s3_bucket_name: "c",
    });

    expect(before).not.toBe(after);
  });

  it("distinguishes an unset value from an empty one only by field", () => {
    const unset = configFingerprint(fields, { aws_access_key_id: "a" });
    const empty = configFingerprint(fields, {
      aws_access_key_id: "a",
      s3_bucket_name: "",
    });

    expect(unset).toBe(empty);
  });

  it("does not collide when values shift between fields", () => {
    const left = configFingerprint(fields, {
      aws_access_key_id: "ab",
      s3_bucket_name: "c",
    });
    const right = configFingerprint(fields, {
      aws_access_key_id: "a",
      s3_bucket_name: "bc",
    });

    expect(left).not.toBe(right);
  });
});

describe("httpStatusOf", () => {
  it("reads the AWS SDK shape", () => {
    expect(httpStatusOf({ $metadata: { httpStatusCode: 403 } })).toBe(403);
  });

  it("reads the Azure RestError shape", () => {
    expect(httpStatusOf({ statusCode: 409 })).toBe(409);
  });

  it("reads the Google ApiError shape", () => {
    expect(httpStatusOf({ code: 404 })).toBe(404);
  });

  it("ignores a non-numeric Google-style code", () => {
    // Some Google errors carry a string code like "ENOTFOUND".
    expect(httpStatusOf({ code: "ENOTFOUND" })).toBeUndefined();
  });

  it("returns undefined for an error with no status", () => {
    expect(httpStatusOf(new Error("boom"))).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf("nope")).toBeUndefined();
  });
});

describe("assertSafeEndpoint", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(() =>
      assertSafeEndpoint("https://t3.storage.dev", false),
    ).not.toThrow();
  });

  it("rejects plaintext http unless explicitly allowed", () => {
    expect(() => assertSafeEndpoint("http://storage.example.com", false)).toThrow(
      /https/,
    );
    expect(() =>
      assertSafeEndpoint("http://storage.example.com", true),
    ).not.toThrow();
  });

  it("rejects loopback and link-local hosts", () => {
    for (const host of [
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://169.254.169.254",
      "https://minio.local",
    ]) {
      expect(() => assertSafeEndpoint(host, true)).toThrow(
        /private or loopback/,
      );
    }
  });

  it("rejects RFC1918 ranges", () => {
    for (const host of [
      "https://10.0.0.5",
      "https://192.168.1.10",
      "https://172.16.0.1",
      "https://172.31.255.254",
    ]) {
      expect(() => assertSafeEndpoint(host, true)).toThrow(
        /private or loopback/,
      );
    }
  });

  it("does not reject a public address that merely looks similar", () => {
    // 172.32.x is outside the private range even though 172.16-31 is inside.
    expect(() => assertSafeEndpoint("https://172.32.0.1", true)).not.toThrow();
  });

  it("rejects a value that is not a URL at all", () => {
    expect(() => assertSafeEndpoint("t3.storage.dev", false)).toThrow(
      /not a valid URL/,
    );
  });
});
