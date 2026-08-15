/**
 * Opt-in round trip against a real storage backend.
 *
 * Skipped unless HH_TEST_STORE_TYPE is set, so it never runs in CI without a
 * scratch bucket. Run it once by hand against Tigris before shipping a
 * backend change:
 *
 *   HH_TEST_STORE_TYPE=tigris \
 *   HH_TEST_STORE_CONFIG='{"tigris_access_key_id":"...","tigris_secret_access_key":"...","tigris_bucket_name":"..."}' \
 *   npx vitest run tests/storage/live-roundtrip.test.ts
 *
 * The keys are the store's own `ConfigField.key` values, which differ between
 * s3 (`aws_*` / `s3_bucket_name`) and tigris (`tigris_*`).
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { v7 as uuidV7 } from "uuid";
import { resolveConfig } from "@/storage/adapters/base";
import { createAdapter, configFieldsFor } from "@/storage/factory";
import { isStoreType } from "@/storage/types";

const storeType = process.env.HH_TEST_STORE_TYPE ?? "";
const rawConfig = process.env.HH_TEST_STORE_CONFIG ?? "{}";

describe.skipIf(!isStoreType(storeType))(
  `live storage round trip (${storeType || "skipped"})`,
  () => {
    it("provisions, writes, reads back and removes an object", async () => {
      if (!isStoreType(storeType)) return;

      const fields = configFieldsFor(storeType);
      const config = resolveConfig(
        fields,
        {},
        JSON.parse(rawConfig) as Record<string, string>,
      );
      const adapter = await createAdapter(storeType, config);

      expect(adapter.name).toBe(storeType);

      await adapter.ensureContainer();

      const destination = `hh_storage_probe/${uuidV7()}`;
      const payload = new Uint8Array(randomBytes(1024));

      const output = await adapter.put(
        payload,
        destination,
        "application/octet-stream",
      );
      expect(output.uri).toBe(destination);

      const readBack = await adapter.downloadAsBytes(destination);
      expect(Array.from(readBack)).toEqual(Array.from(payload));

      await adapter.delete(destination);
      await expect(adapter.downloadAsBytes(destination)).rejects.toThrow();
    }, 60_000);
  },
);
