import { type Kysely, sql } from "kysely";
import { createHash, randomUUID } from "node:crypto";

/**
 * Migration: storage_backend_config_continuity
 * Created at: 2026-08-15
 * Description: Keep already-stored files readable across the storage rework.
 * Depends on: 20250313_create_server_variables_table
 *
 * Two changes to `apps/server/src/storage` need existing `server_variables`
 * rows moved or filled in, or reads of files uploaded before the rework start
 * returning 503:
 *
 * 1. Tigris no longer reuses the `aws_*` / `s3_bucket_name` keys. It reads
 *    `tigris_*` instead, so both S3-compatible backends can be configured at
 *    once and neither overwrites the other. A deployment already on Tigris has
 *    its credentials under the old names, so they are copied across. The old
 *    rows are then cleared: they hold Tigris credentials, and leaving them
 *    would let the native-S3 adapter sign them to `s3.amazonaws.com`,
 *    disclosing a live key to a third party. Nothing outside the storage
 *    module reads these keys — verified by grep before writing this.
 *
 * 2. `s3_bucket_name` and `gcp_bucket_name` lost their hardcoded defaults
 *    (`hikmahealth-s3` / `hikmahealthdata.appspot.com`) and became required.
 *    A deployment that relied on either default has no row to fall back on, so
 *    the old default is written out explicitly. This restores prior behaviour
 *    exactly, including for self-hosted installs: those deployments are
 *    already reading and writing that bucket today, and the row grants no
 *    access the stored credential did not already imply. It is a record of
 *    where their files actually are, not a new grant.
 *
 * Both steps are conditional on there being a credential to preserve, so a
 * deployment on disk storage — the default — is untouched.
 *
 * ORDERING: run this with the matching code release, not ahead of it. The
 * clearing step in (1) removes the only keys a pre-release instance knows how
 * to read for Tigris, so any old instance still serving traffic afterwards
 * returns 503 on attachment downloads until it is replaced.
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
 * signed with `us-east-1`. `tigris_region` now defaults to `auto`, which
 * changes the SigV4 credential scope — Tigris accepts either, but a migration
 * is not the place to find out. Pin the old value explicitly.
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
      id: randomUUID(),
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

  // Before the rework, only the Tigris field set carried an endpoint, so a
  // stored endpoint is the one reliable marker that these credentials belong
  // to Tigris. A deployment explicitly on native S3 is excluded: the old code
  // ignored the endpoint there, so the credentials are genuinely AWS ones and
  // any endpoint row is leftover junk.
  const endpointRow = variables.get("aws_endpoint_url_s3");
  const isTigrisConfig = hasValue(endpointRow) && storeType !== "s3";

  if (isTigrisConfig) {
    const superseded: string[] = [];
    for (const [fromKey, toKey] of TIGRIS_KEY_MOVES) {
      const source = variables.get(fromKey);
      if (!hasValue(source)) continue;
      // Never clobber a value already written under the new name — an admin
      // who configured Tigris through the settings screen before this ran has
      // the better value. Either way the old row still holds a Tigris
      // credential, so it is cleared below whether or not it was copied.
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

  // Skipped when the block above already claimed the AWS keys for Tigris —
  // there is no native-S3 configuration left to complete. GCS is independent
  // of both and is handled either way, since a deployment can carry a stale
  // configuration for a backend it no longer writes to but still reads from.
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
  // Namespacing means both backends can now be configured at once, and the old
  // schema has nowhere to put the second one — so a populated AWS key wins and
  // the Tigris value is left where it is rather than overwriting a live
  // credential. Rolling back with both configured is therefore lossy for
  // Tigris; that is inherent to the shape being rolled back to.
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

  // Drop the bucket names only while they still hold the value this migration
  // wrote — an admin who has since set their own keeps it. `s3_bucket_name` is
  // skipped when the restore above just wrote a Tigris bucket into it.
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
