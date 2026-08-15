import { createHash } from "node:crypto";
import { Logger } from "@hikmahealth/js-utils";
import type { StorageAdapter } from "./adapters/base.ts";
import { ResourceOperationError } from "./errors.ts";
import type { PutOutput, StoreType } from "./types.ts";

/**
 * Backends whose digest is definitionally the MD5 of what we sent, so a
 * mismatch means corruption. Elsewhere a mismatch is possible on a correct
 * upload — an S3 ETag is not the content MD5 for multipart or SSE-KMS objects
 * — so those are logged rather than failed.
 */
const STRICT_DIGEST_STORES: ReadonlySet<StoreType> = new Set(["disk", "gcp"]);

export type IntegrityVerdict =
  | { readonly outcome: "match" }
  | { readonly outcome: "skipped" }
  | {
      readonly outcome: "mismatch";
      readonly fatal: boolean;
      readonly expected: string;
      readonly actual: string;
    };

/**
 * Compare a provider-returned digest against the bytes that were sent. The
 * MD5 is a transport check, not a security property — `resources.hash`
 * carries a server-computed SHA-256.
 */
export const verifyPutIntegrity = (
  store: StoreType,
  output: PutOutput,
  data: Uint8Array,
): IntegrityVerdict => {
  const [algorithm, digest] = output.hash;
  if (algorithm !== "md5" || digest === "") return { outcome: "skipped" };

  const expected = createHash("md5").update(data).digest("hex");
  if (expected === digest.toLowerCase()) return { outcome: "match" };

  return {
    outcome: "mismatch",
    fatal: STRICT_DIGEST_STORES.has(store),
    expected,
    actual: digest.toLowerCase(),
  };
};

/**
 * Write bytes and verify what the backend says it stored. A fatal mismatch
 * removes the object and throws, so no `resources` row ever points at a
 * corrupt upload.
 */
export const putVerified = async (
  adapter: StorageAdapter,
  data: Uint8Array,
  destination: string,
  mimetype: string,
): Promise<PutOutput> => {
  const output = await adapter.put(data, destination, mimetype);
  const verdict = verifyPutIntegrity(adapter.name, output, data);

  if (verdict.outcome === "mismatch") {
    if (verdict.fatal) {
      try {
        await adapter.delete(destination);
      } catch (cleanupError) {
        Logger.error({
          msg: "[storage] failed to remove object after digest mismatch",
          store: adapter.name,
          destination,
          error: cleanupError,
        });
      }
      throw new ResourceOperationError(
        "put",
        new Error(
          `Stored digest ${verdict.actual} does not match sent digest ${verdict.expected}`,
        ),
      );
    }

    Logger.warn({
      msg: "[storage] provider digest differs from local MD5",
      store: adapter.name,
      destination,
    });
  }

  return output;
};
