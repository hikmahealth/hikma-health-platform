import { type Kysely, sql } from "kysely";
import { createHash } from "node:crypto";
import { v7 as uuidV7 } from "uuid";

/**
 * Migration: storage_backend_config_continuity
 * Created at: 2026-08-15
 * Description: Keep already-stored files readable across the storage rework.
 * Depends on: 20250313_create_server_variables_table
 *
 * Two storage changes leave existing `server_variables` rows pointing at the
 * wrong place, so reads of files uploaded beforehand start returning 503:
 *
 * 1. Tigris reads `tigris_*` instead of reusing `aws_*` / `s3_bucket_name`, so
 *    both S3-compatible backends can be configured at once. Credentials are
 *    copied across and the old rows cleared — left in place, the native-S3
 *    adapter would sign them to `s3.amazonaws.com` and every request would
 *    fail as a confusing 403.
 *
 * 2. `s3_bucket_name` and `gcp_bucket_name` lost their hardcoded defaults
 *    (`hikmahealth-s3` / `hikmahealthdata.appspot.com`) and became required,
 *    so a deployment that relied on either gets the old default written out.
 *
 * Both steps need a credential to already be present, so a deployment on disk
 * storage is untouched.
 *
 * ORDERING: run this with the matching code release, not ahead of it. Step 1
 * clears the only keys a pre-release instance knows how to read for Tigris.
 * A fork still running its own code against `aws_*` recovers with `down()`,
 * which is the only place those values survive — `up()` nulls them.
 */

const TIGRIS_KEY_MOVES = [
  ["aws_access_key_id", "tigris_access_key_id"],
  ["aws_secret_access_key", "tigris_secret_access_key"],
  ["aws_region", "tigris_region"],
  ["s3_bucket_name", "tigris_bucket_name"],
  ["aws_endpoint_url_s3", "tigris_endpoint_url"],
] as const;

const LEGACY_S3_BUCKET = "hikmahealth-s3";
const LEGACY_GCP_BUCKET = "hikmahealthdata.appspot.com";

/**
 * Tigris shared the S3 field set, so a deployment that never chose a region
 * signed with `us-east-1`. `tigris_region` defaults to `auto`, which changes
 * the SigV4 credential scope, so pin the old value explicitly.
 */
const LEGACY_TIGRIS_REGION = "us-east-1";

type VariableRow = {
  key: string;
  value_type: string;
  value_data: Buffer | null;
  value_hash: string | null;
};

const readVariables = async (
  db: Kysely<any>,
  keys: readonly string[],
): Promise<Map<string, VariableRow>> => {
  const rows = (await db
    .selectFrom("server_variables")
    .select(["key", "value_type", "value_data", "value_hash"])
    .where("key", "in", [...keys])
    .execute()) as VariableRow[];

  return new Map(rows.map((row) => [row.key, row]));
};

/** A key counts as configured only when it holds a non-empty value. */
const hasValue = (row: VariableRow | undefined): row is VariableRow =>
  row?.value_data != null && row.value_data.length > 0;

const decode = (row: VariableRow): string =>
  Buffer.from(row.value_data as Buffer).toString("utf8");

const upsertVariable = async (
  db: Kysely<any>,
  variable: {
    key: string;
    value_type: string;
    value_data: Buffer;
    value_hash: string;
    description: string;
  },
): Promise<void> => {
  await db
    .insertInto("server_variables")
    .values({
      id: uuidV7(),
      key: variable.key,
      description: variable.description,
      value_type: variable.value_type,
      value_data: variable.value_data,
      value_hash: variable.value_hash,
    })
    .onConflict((oc: any) =>
      oc.column("key").doUpdateSet({
        value_type: variable.value_type,
        value_data: variable.value_data,
        value_hash: variable.value_hash,
        updated_at: sql`now()`,
      }),
    )
    .execute();
};

/** Copy a row's bytes verbatim, hash included — the value is unchanged. */
const copyVariable = async (
  db: Kysely<any>,
  source: VariableRow,
  toKey: string,
  description: string,
): Promise<void> =>
  upsertVariable(db, {
    key: toKey,
    value_type: source.value_type,
    value_data: source.value_data as Buffer,
    value_hash:
      source.value_hash ??
      createHash("sha256")
        .update(source.value_data as Buffer)
        .digest("hex"),
    description,
  });

const setStringVariable = async (
  db: Kysely<any>,
  key: string,
  value: string,
  description: string,
): Promise<void> => {
  const bytes = Buffer.from(value, "utf8");
  await upsertVariable(db, {
    key,
    value_type: "string",
    value_data: bytes,
    value_hash: createHash("sha256").update(bytes).digest("hex"),
    description,
  });
};

/** Blank the value but keep the row, matching ServerVariable.clearValue. */
const clearVariables = async (
  db: Kysely<any>,
  keys: readonly string[],
): Promise<void> => {
  await db
    .updateTable("server_variables")
    .set({ value_data: null, value_hash: null, updated_at: sql`now()` })
    .where("key", "in", [...keys])
    .execute();
};

export async function up(db: Kysely<any>): Promise<void> {
  const variables = await readVariables(db, [
    "hh_store_type",
    ...TIGRIS_KEY_MOVES.flat(),
    "gcp_service_account",
    "gcp_bucket_name",
  ]);

  const storeTypeRow = variables.get("hh_store_type");
  const storeType = hasValue(storeTypeRow) ? decode(storeTypeRow) : "disk";

  // Only the Tigris field set carried an endpoint, so a stored endpoint marks
  // these credentials as Tigris's. A deployment explicitly on native S3 is
  // excluded — there the old code ignored the endpoint, so the row is junk.
  const endpointRow = variables.get("aws_endpoint_url_s3");
  const isTigrisConfig = hasValue(endpointRow) && storeType !== "s3";

  if (isTigrisConfig) {
    const superseded: string[] = [];
    for (const [fromKey, toKey] of TIGRIS_KEY_MOVES) {
      const source = variables.get(fromKey);
      if (!hasValue(source)) continue;
      // Keep a value already written under the new name, but clear the old
      // row either way — it still holds a Tigris credential.
      if (!hasValue(variables.get(toKey))) {
        await copyVariable(db, source, toKey, `Tigris storage: ${toKey}`);
      }
      superseded.push(fromKey);
    }
    if (!hasValue(variables.get("aws_region")) && !hasValue(variables.get("tigris_region"))) {
      await setStringVariable(
        db,
        "tigris_region",
        LEGACY_TIGRIS_REGION,
        "Tigris region (pinned to the region this deployment already signs with)",
      );
    }

    if (superseded.length > 0) {
      await clearVariables(db, superseded);
    }
  }

  // Skipped when the block above claimed the AWS keys for Tigris. GCS is
  // independent of both and is handled either way.
  const s3KeyRow = variables.get("aws_access_key_id");
  if (
    !isTigrisConfig &&
    hasValue(s3KeyRow) &&
    !hasValue(variables.get("s3_bucket_name"))
  ) {
    await setStringVariable(
      db,
      "s3_bucket_name",
      LEGACY_S3_BUCKET,
      "S3 bucket name (restored from the removed built-in default)",
    );
  }

  const gcpAccountRow = variables.get("gcp_service_account");
  if (hasValue(gcpAccountRow) && !hasValue(variables.get("gcp_bucket_name"))) {
    await setStringVariable(
      db,
      "gcp_bucket_name",
      LEGACY_GCP_BUCKET,
      "GCS bucket name (restored from the removed built-in default)",
    );
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  const variables = await readVariables(db, [
    ...TIGRIS_KEY_MOVES.flat(),
    "gcp_bucket_name",
  ]);

  // Move Tigris credentials back onto the shared AWS keys the old code read.
  // The old schema has nowhere to put a second S3-compatible config, so a
  // populated AWS key wins and the Tigris value is left where it is. Rolling
  // back with both configured is therefore lossy for Tigris.
  const restored: string[] = [];
  for (const [fromKey, toKey] of TIGRIS_KEY_MOVES) {
    const source = variables.get(toKey);
    if (!hasValue(source) || hasValue(variables.get(fromKey))) continue;
    await copyVariable(db, source, fromKey, `Storage: ${fromKey}`);
    restored.push(toKey);
  }
  if (restored.length > 0) {
    await clearVariables(db, restored);
  }

  // Drop the bucket names only while they still hold what this migration
  // wrote. Skip `s3_bucket_name` when the restore above put a Tigris bucket
  // there.
  const candidates = (
    [
      ["s3_bucket_name", LEGACY_S3_BUCKET],
      ["gcp_bucket_name", LEGACY_GCP_BUCKET],
    ] as const
  ).filter(
    ([key]) => !(key === "s3_bucket_name" && restored.includes("tigris_bucket_name")),
  );

  const current = await readVariables(
    db,
    candidates.map(([key]) => key),
  );
  for (const [key, seeded] of candidates) {
    const row = current.get(key);
    if (hasValue(row) && decode(row) === seeded) {
      await db.deleteFrom("server_variables").where("key", "=", key).execute();
    }
  }
}
