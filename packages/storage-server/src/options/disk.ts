import fs from "node:fs/promises";
import path from "node:path";
import { StoreManager, ResourceNotFoundError } from "../core/index.js";

/**
 * Storing the resources to disk.
 */
export class DiskStoreManager implements StoreManager {
  readonly baseDir: string;

  constructor(options: { dir: string }) {
    // If dir is absolute, use it as-is; otherwise resolve relative to cwd
    this.baseDir = path.isAbsolute(options.dir)
      ? options.dir
      : path.join(process.cwd(), options.dir);
  }

  private resolvePath(filePath: string): string {
    // Prevent path traversal outside baseDir
    const resolved = path.resolve(this.baseDir, filePath);
    if (!resolved.startsWith(path.resolve(this.baseDir))) {
      throw new Error(`invalid path: ${filePath}`);
    }
    return resolved;
  }

  async put(
    data: Uint8Array,
    filePath: string,
    _mimetype?: string,
  ): Promise<void> {
    const dest = this.resolvePath(filePath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }

  async delete(filePath: string): Promise<void> {
    const dest = this.resolvePath(filePath);
    try {
      await fs.unlink(dest);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new ResourceNotFoundError(filePath);
      }
      throw err;
    }
  }

  async downloadAsBytes(filePath: string): Promise<Uint8Array> {
    const dest = this.resolvePath(filePath);
    try {
      const buffer = await fs.readFile(dest);
      return new Uint8Array(buffer);
    } catch (err: any) {
      if (err.code === "ENOENT") {
        throw new ResourceNotFoundError(filePath);
      }
      throw err;
    }
  }
}
