import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiskAdapter, resolveSafePath } from "@/storage/adapters/disk";
import { RESOURCE_PATH_PREFIX } from "@/storage/types";

describe("resolveSafePath", () => {
  const base = "/srv/hikma/resources";

  it("resolves a plain destination inside the base directory", () => {
    expect(resolveSafePath(base, "forms/abc")).toBe(`${base}/forms/abc`);
  });

  it("rejects a parent-directory escape", () => {
    expect(() => resolveSafePath(base, "../secrets")).toThrow(
      /Path traversal/,
    );
  });

  it("rejects a nested parent-directory escape", () => {
    expect(() => resolveSafePath(base, "forms/../../secrets")).toThrow(
      /Path traversal/,
    );
  });

  it("rejects an absolute destination", () => {
    expect(() => resolveSafePath(base, "/etc/passwd")).toThrow(
      /Path traversal/,
    );
  });

  it("does not mistake a sibling directory for the base", () => {
    // "/srv/hikma/resources-other" must not pass a naive startsWith check.
    expect(() => resolveSafePath(base, "../resources-other/file")).toThrow(
      /Path traversal/,
    );
  });

  it("allows the base directory itself", () => {
    expect(resolveSafePath(base, ".")).toBe(base);
  });
});

describe("disk adapter", () => {
  let baseDir = "";

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "hh-storage-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("round-trips bytes through put and downloadAsBytes", async () => {
    const adapter = await createDiskAdapter(baseDir);
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const destination = `${RESOURCE_PATH_PREFIX}/round-trip`;

    const output = await adapter.put(bytes, destination, "text/plain");
    expect(output.uri).toBe(destination);

    const readBack = await adapter.downloadAsBytes(destination);
    expect(Array.from(readBack)).toEqual(Array.from(bytes));
  });

  it("creates parent directories without a prior ensureContainer call", async () => {
    // Uploads never call ensureContainer, so put must stand on its own.
    const adapter = await createDiskAdapter(baseDir);
    const destination = `${RESOURCE_PATH_PREFIX}/nested/file`;

    await adapter.put(new Uint8Array([1]), destination, "text/plain");

    const written = await readFile(resolve(baseDir, destination));
    expect(Array.from(written)).toEqual([1]);
  });

  it("reports itself as the disk store so resources rows record it", async () => {
    const adapter = await createDiskAdapter(baseDir);
    expect(adapter.name).toBe("disk");
  });

  it("deletes an object and treats a missing one as already deleted", async () => {
    const adapter = await createDiskAdapter(baseDir);
    const destination = `${RESOURCE_PATH_PREFIX}/to-delete`;

    await adapter.put(new Uint8Array([1]), destination, "text/plain");
    await adapter.delete(destination);
    await expect(adapter.delete(destination)).resolves.toBeUndefined();
    await expect(adapter.downloadAsBytes(destination)).rejects.toThrow();
  });

  it("rejects an upload above the size limit", async () => {
    const adapter = await createDiskAdapter(baseDir);
    const tooBig = new Uint8Array(51 * 1024 * 1024);

    await expect(
      adapter.put(tooBig, `${RESOURCE_PATH_PREFIX}/big`, "application/pdf"),
    ).rejects.toThrow(/size limit/);
  });

  it("rejects a mimetype outside the allowlist", async () => {
    const adapter = await createDiskAdapter(baseDir);

    await expect(
      adapter.put(
        new Uint8Array([1]),
        `${RESOURCE_PATH_PREFIX}/script`,
        "application/x-sh",
      ),
    ).rejects.toThrow(/Mimetype not allowed/);
  });
});
