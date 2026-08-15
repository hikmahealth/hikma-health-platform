/**
 * Covers 20260815_storage_backend_config_continuity, the migration that keeps
 * files uploaded before the storage rework readable afterwards.
 *
 * There is no migration test harness in this repo and every configured
 * database is a hosted one, so this drives the migration against an in-memory
 * stand-in for the narrow slice of Kysely it uses. The point is the decision
 * logic — which deployments get rewritten and which are left alone — not the
 * SQL generation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  up,
  down,
} from "../../../../database/migrations/20260815_storage_backend_config_continuity";

type Row = {
  id: string;
  key: string;
  description: string | null;
  value_type: string;
  value_data: Buffer | null;
  value_hash: string | null;
};

/** Minimal Kysely double: selectFrom / insertInto / updateTable / deleteFrom. */
const fakeDb = (rows: Map<string, Row>) => {
  const matches = (
    key: string,
    op: "in" | "=",
    operand: readonly string[] | string,
  ): boolean =>
    op === "in" ? (operand as readonly string[]).includes(key) : key === operand;

  return {
    selectFrom: () => ({
      select: () => ({
        where: (_column: string, op: "in" | "=", operand: any) => ({
          execute: async () =>
            [...rows.values()].filter((row) => matches(row.key, op, operand)),
        }),
      }),
    }),
    insertInto: () => ({
      values: (values: Row) => ({
        onConflict: (build: (oc: any) => any) => {
          const update = build({
            column: () => ({ doUpdateSet: (set: any) => set }),
          });
          return {
            execute: async () => {
              const existing = rows.get(values.key);
              if (existing) {
                rows.set(values.key, {
                  ...existing,
                  value_type: update.value_type,
                  value_data: update.value_data,
                  value_hash: update.value_hash,
                });
              } else {
                rows.set(values.key, values);
              }
            },
          };
        },
      }),
    }),
    updateTable: () => ({
      set: (patch: Partial<Row>) => ({
        where: (_column: string, op: "in" | "=", operand: any) => ({
          execute: async () => {
            for (const row of rows.values()) {
              if (!matches(row.key, op, operand)) continue;
              rows.set(row.key, {
                ...row,
                value_data: patch.value_data ?? null,
                value_hash: patch.value_hash ?? null,
              });
            }
          },
        }),
      }),
    }),
    deleteFrom: () => ({
      where: (_column: string, op: "in" | "=", operand: any) => ({
        execute: async () => {
          for (const key of [...rows.keys()]) {
            if (matches(key, op, operand)) rows.delete(key);
          }
        },
      }),
    }),
  } as any;
};

let rows: Map<string, Row>;

const seed = (values: Record<string, string | null>): void => {
  for (const [key, value] of Object.entries(values)) {
    rows.set(key, {
      id: `id-${key}`,
      key,
      description: null,
      value_type: key === "gcp_service_account" ? "json" : "string",
      value_data: value === null ? null : Buffer.from(value, "utf8"),
      value_hash: value === null ? null : `hash-of-${value}`,
    });
  }
};

const read = (key: string): string | null => {
  const row = rows.get(key);
  if (!row?.value_data || row.value_data.length === 0) return null;
  return row.value_data.toString("utf8");
};

beforeEach(() => {
  rows = new Map();
});

describe("storage config continuity — Tigris key migration", () => {
  const tigrisDeployment = {
    hh_store_type: "tigris",
    aws_access_key_id: "tid_live_key",
    aws_secret_access_key: "tsec_live_secret",
    aws_region: "auto",
    s3_bucket_name: "clinic-attachments",
    aws_endpoint_url_s3: "https://t3.storage.dev",
  };

  it("moves an existing Tigris configuration onto the tigris_ keys", async () => {
    seed(tigrisDeployment);

    await up(fakeDb(rows));

    expect(read("tigris_access_key_id")).toBe("tid_live_key");
    expect(read("tigris_secret_access_key")).toBe("tsec_live_secret");
    expect(read("tigris_region")).toBe("auto");
    expect(read("tigris_bucket_name")).toBe("clinic-attachments");
    expect(read("tigris_endpoint_url")).toBe("https://t3.storage.dev");
  });

  it("copies the stored hash rather than recomputing it", async () => {
    seed(tigrisDeployment);

    await up(fakeDb(rows));

    expect(rows.get("tigris_access_key_id")?.value_hash).toBe(
      "hash-of-tid_live_key",
    );
  });

  it("clears the AWS keys so a Tigris credential is never signed to AWS", async () => {
    seed(tigrisDeployment);

    await up(fakeDb(rows));

    for (const key of [
      "aws_access_key_id",
      "aws_secret_access_key",
      "s3_bucket_name",
      "aws_endpoint_url_s3",
    ]) {
      expect(read(key)).toBeNull();
    }
    // The row survives, so the settings screen still reports "not set"
    // rather than losing the key entirely.
    expect(rows.has("aws_access_key_id")).toBe(true);
  });

  it("treats a stored endpoint as Tigris even when the active store is disk", async () => {
    // The endpoint could only have been written while Tigris was configured,
    // so the credentials are Tigris's regardless of what is active now.
    seed({ ...tigrisDeployment, hh_store_type: "disk" });

    await up(fakeDb(rows));

    expect(read("tigris_access_key_id")).toBe("tid_live_key");
    expect(read("aws_access_key_id")).toBeNull();
  });

  it("leaves a native S3 deployment alone even with a stale endpoint row", async () => {
    // hh_store_type=s3 means the old code ignored the endpoint, so these are
    // genuine AWS credentials and the endpoint row is leftover junk.
    seed({
      hh_store_type: "s3",
      aws_access_key_id: "AKIAEXAMPLE",
      aws_secret_access_key: "aws_secret",
      s3_bucket_name: "real-aws-bucket",
      aws_endpoint_url_s3: "https://t3.storage.dev",
    });

    await up(fakeDb(rows));

    expect(read("aws_access_key_id")).toBe("AKIAEXAMPLE");
    expect(read("s3_bucket_name")).toBe("real-aws-bucket");
    expect(read("tigris_access_key_id")).toBeNull();
  });

  it("pins the region a Tigris deployment was already signing with", async () => {
    // Never stored a region, so it was using the old us-east-1 default. The
    // new tigris_region default is "auto", which changes the SigV4 scope.
    const { aws_region: _dropped, ...noRegion } = tigrisDeployment;
    seed(noRegion);

    await up(fakeDb(rows));

    expect(read("tigris_region")).toBe("us-east-1");
  });

  it("keeps an explicitly stored region over the pinned default", async () => {
    seed({ ...tigrisDeployment, aws_region: "auto" });

    await up(fakeDb(rows));

    expect(read("tigris_region")).toBe("auto");
  });

  it("never clobbers a value already written under the new name", async () => {
    seed({ ...tigrisDeployment, tigris_bucket_name: "already-set" });

    await up(fakeDb(rows));

    expect(read("tigris_bucket_name")).toBe("already-set");
  });

  it("clears an old key it skipped because the new name was taken", async () => {
    // Preserving the new value is right, but the old row still holds a Tigris
    // credential. Leaving it is what the clearing step exists to prevent.
    seed({ ...tigrisDeployment, tigris_bucket_name: "already-set" });

    await up(fakeDb(rows));

    expect(read("s3_bucket_name")).toBeNull();
  });

  it("clears the AWS keys when the whole tigris_ set is already populated", async () => {
    // An admin who configured Tigris through the new settings screen before
    // this migration ran leaves every copy a no-op. Without clearing, the
    // native-S3 adapter still builds from these Tigris credentials.
    seed({
      ...tigrisDeployment,
      tigris_access_key_id: "tid_live_key",
      tigris_secret_access_key: "tsec_live_secret",
      tigris_region: "auto",
      tigris_bucket_name: "clinic-attachments",
      tigris_endpoint_url: "https://t3.storage.dev",
    });

    await up(fakeDb(rows));

    expect(read("aws_access_key_id")).toBeNull();
    expect(read("aws_secret_access_key")).toBeNull();
    expect(read("s3_bucket_name")).toBeNull();
  });
});

describe("storage config continuity — removed bucket defaults", () => {
  it("restores the S3 bucket default for a deployment that relied on it", async () => {
    seed({
      hh_store_type: "s3",
      aws_access_key_id: "AKIAEXAMPLE",
      aws_secret_access_key: "aws_secret",
    });

    await up(fakeDb(rows));

    expect(read("s3_bucket_name")).toBe("hikmahealth-s3");
  });

  it("restores the GCS bucket default for a deployment that relied on it", async () => {
    seed({
      hh_store_type: "gcp",
      gcp_service_account: '{"type":"service_account"}',
    });

    await up(fakeDb(rows));

    expect(read("gcp_bucket_name")).toBe("hikmahealthdata.appspot.com");
  });

  it("leaves an explicitly configured bucket name untouched", async () => {
    seed({
      hh_store_type: "s3",
      aws_access_key_id: "AKIAEXAMPLE",
      s3_bucket_name: "our-own-bucket",
      gcp_service_account: '{"type":"service_account"}',
      gcp_bucket_name: "our-own-gcs-bucket",
    });

    await up(fakeDb(rows));

    expect(read("s3_bucket_name")).toBe("our-own-bucket");
    expect(read("gcp_bucket_name")).toBe("our-own-gcs-bucket");
  });

  it("repairs a stale GCS configuration alongside a Tigris migration", async () => {
    // A deployment that moved GCS -> Tigris still reads its old resources
    // rows, so both backends have to come out of this working.
    seed({
      hh_store_type: "tigris",
      aws_access_key_id: "tid_live_key",
      aws_secret_access_key: "tsec_live_secret",
      s3_bucket_name: "clinic-attachments",
      aws_endpoint_url_s3: "https://t3.storage.dev",
      gcp_service_account: '{"type":"service_account"}',
    });

    await up(fakeDb(rows));

    expect(read("tigris_bucket_name")).toBe("clinic-attachments");
    expect(read("gcp_bucket_name")).toBe("hikmahealthdata.appspot.com");
  });

  it("writes nothing for a deployment that never configured a cloud backend", async () => {
    seed({ hh_store_type: "disk", disk_storage_path: "/data/uploads" });

    await up(fakeDb(rows));

    expect(read("s3_bucket_name")).toBeNull();
    expect(read("gcp_bucket_name")).toBeNull();
    expect(rows.size).toBe(2);
  });

  it("is idempotent", async () => {
    seed({
      hh_store_type: "gcp",
      gcp_service_account: '{"type":"service_account"}',
    });

    await up(fakeDb(rows));
    const afterFirst = read("gcp_bucket_name");
    await up(fakeDb(rows));

    expect(read("gcp_bucket_name")).toBe(afterFirst);
  });
});

describe("storage config continuity — down", () => {
  it("moves Tigris credentials back onto the shared AWS keys", async () => {
    seed({
      hh_store_type: "tigris",
      tigris_access_key_id: "tid_live_key",
      tigris_secret_access_key: "tsec_live_secret",
      tigris_bucket_name: "clinic-attachments",
      tigris_endpoint_url: "https://t3.storage.dev",
    });

    await down(fakeDb(rows));

    expect(read("aws_access_key_id")).toBe("tid_live_key");
    expect(read("s3_bucket_name")).toBe("clinic-attachments");
    expect(read("aws_endpoint_url_s3")).toBe("https://t3.storage.dev");
    expect(read("tigris_access_key_id")).toBeNull();
  });

  it("does not overwrite live AWS credentials when both backends are configured", async () => {
    // The old schema has one slot for two backends. A populated AWS key wins;
    // rolling back is lossy for Tigris rather than destructive for S3.
    seed({
      hh_store_type: "s3",
      aws_access_key_id: "AKIAEXAMPLE",
      aws_secret_access_key: "aws_secret",
      s3_bucket_name: "real-aws-bucket",
      tigris_access_key_id: "tid_live_key",
      tigris_bucket_name: "clinic-attachments",
    });

    await down(fakeDb(rows));

    expect(read("aws_access_key_id")).toBe("AKIAEXAMPLE");
    expect(read("s3_bucket_name")).toBe("real-aws-bucket");
    expect(read("tigris_access_key_id")).toBe("tid_live_key");
  });

  it("does not delete a restored Tigris bucket that happens to match the seed", async () => {
    seed({
      hh_store_type: "tigris",
      tigris_access_key_id: "tid_live_key",
      tigris_bucket_name: "hikmahealth-s3",
    });

    await down(fakeDb(rows));

    expect(read("s3_bucket_name")).toBe("hikmahealth-s3");
  });

  it("removes a seeded bucket name but keeps an admin-chosen one", async () => {
    seed({
      hh_store_type: "gcp",
      s3_bucket_name: "hikmahealth-s3",
      gcp_bucket_name: "our-own-gcs-bucket",
    });

    await down(fakeDb(rows));

    expect(rows.has("s3_bucket_name")).toBe(false);
    expect(read("gcp_bucket_name")).toBe("our-own-gcs-bucket");
  });
});
