import { BodyData } from "hono/utils/body";
import {
  ResourceNotFoundError,
  StoreManager,
  UnsupportedMimeTypeError,
} from "../../core/index.js";

export async function downloadFile(
  manager: StoreManager,
  path: string,
): Promise<Response> {
  try {
    const bytes = await manager.downloadAsBytes(path);
    return new Response(bytes, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch (e) {
    if (e instanceof ResourceNotFoundError) {
      return new Response(e.message, { status: 404 });
    }
    return new Response("failed to retrieve file", { status: 500 });
  }
}

export async function uploadFile(
  manager: StoreManager,
  path: string,
  bytes: number[],
  mimetype?: string,
): Promise<Response> {
  try {
    await manager.put(new Uint8Array(bytes), path, mimetype);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof UnsupportedMimeTypeError) {
      return new Response(e.message, { status: 415 });
    }
    return new Response("failed to save file", { status: 500 });
  }
}

export async function removeFile(
  manager: StoreManager,
  path: string,
): Promise<Response> {
  try {
    await manager.delete(path);
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof ResourceNotFoundError) {
      return new Response(e.message, { status: 404 });
    }
    return new Response("failed to delete file", { status: 500 });
  }
}
