import { Hono } from "hono";
import { StoreManager } from "../../core/index.js";
import { serve } from "@hono/node-server";
import { HTTPException } from "hono/http-exception";
import { downloadFile, uploadFile, removeFile } from "./fns.js";

export * from "./fns.js";

/**
 * Exposes the functionality of the storage through a HTTP server
 */
export function httpServe(
  manager: StoreManager,
  options: {
    port: number;
  },
) {
  const f = new Hono();

  f.get("/file/:path*", async (c) => {
    const path = c.req.param("path");
    if (!path) throw new HTTPException(400, { message: "path is required" });
    return downloadFile(manager, path);
  });

  f.put("/file/:path*", async (c) => {
    const path = c.req.param("path");
    if (!path) throw new HTTPException(400, { message: "path is required" });

    const data = await c.req.arrayBuffer();
    if (!data || data.byteLength === 0) {
      throw new HTTPException(400, { message: "payload is required" });
    }

    const mimetype = c.req.header("Content-Type");
    return uploadFile(
      manager,
      path,
      Array.from(new Uint8Array(data)),
      mimetype,
    );
  });

  f.delete("/file/:path*", async (c) => {
    const path = c.req.param("path");
    if (!path) throw new HTTPException(400, { message: "path is required" });
    return removeFile(manager, path);
  });

  serve({
    fetch: f.fetch,
    port: options.port,
  });
}
