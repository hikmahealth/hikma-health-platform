import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { StorageAdapter } from "./base.ts";
import { validatePut } from "./base.ts";
import type { ConfigField, PutOutput } from "../types.ts";

const DEFAULT_BASE_PATH = "./data/resources";

export const diskConfigFields: readonly ConfigField[] = [
  {
    key: "disk_storage_path",
    label: "Storage directory",
    description:
      "Filesystem path on the server where uploaded files are written. Relative paths are resolved against the server's working directory.",
    placeholder: DEFAULT_BASE_PATH,
    required: false,
    secret: false,
    valueType: "string",
    default: DEFAULT_BASE_PATH,
  },
] as const;

/**
 * Resolve a destination within the base path, rejecting path traversal.
 * Throws if the resolved path escapes the base directory.
 */
export const resolveSafePath = (
  basePath: string,
  destination: string,
): string => {
  const resolvedBase = resolve(basePath);
  // resolve() against base collapses any ../ segments into an absolute path
  const full = resolve(resolvedBase, destination);

  // Compare against base + separator so "/base-other" does not match "/base".
  if (!full.startsWith(`${resolvedBase}/`) && full !== resolvedBase) {
    throw new Error(
      `Path traversal detected: "${destination}" escapes base directory`,
    );
  }
  return full;
};

const computeMd5 = (data: Uint8Array): string =>
  createHash("md5").update(data).digest("hex");

export const createDiskAdapter = async (
  basePath: string = DEFAULT_BASE_PATH,
): Promise<StorageAdapter> => {
  const resolvedBase = resolve(basePath);

  return {
    name: "disk",
    version: "disk.202603.01",

    async ensureContainer(): Promise<void> {
      await mkdir(resolvedBase, { recursive: true });
    },

    async put(
      data: Uint8Array,
      destination: string,
      mimetype?: string,
    ): Promise<PutOutput> {
      validatePut(data, mimetype);
      const fullPath = resolveSafePath(resolvedBase, destination);
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (parentDir) {
        await mkdir(parentDir, { recursive: true });
      }

      await writeFile(fullPath, data);
      const digest = computeMd5(data);

      return { uri: destination, hash: ["md5", digest] as const };
    },

    async delete(uri: string): Promise<void> {
      const fullPath = resolveSafePath(resolvedBase, uri);
      await rm(fullPath, { force: true });
    },

    async downloadAsBytes(uri: string): Promise<Uint8Array> {
      const fullPath = resolveSafePath(resolvedBase, uri);
      const buffer = await readFile(fullPath);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
};
