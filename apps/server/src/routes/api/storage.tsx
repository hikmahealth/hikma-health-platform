import { createFileRoute } from "@tanstack/react-router";
import {
  downloadFile,
  uploadFile,
  removeFile,
} from "@hikmahealth/storage-server/serve/node";
import { store, getFile, putFile, deleteFile } from "@/lib/storage.server";

export const Route = createFileRoute("/api/storage")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const path = url.searchParams.get("path");
        if (!path) {
          return new Response("path is required", { status: 400 });
        }
        return downloadFile(store, path);
      },

      POST: async ({ request }) => {
        const body = (await request.json()) as {
          path: string;
          bytes: number[];
          mimetype?: string;
        };
        if (!body.path || !body.bytes) {
          return new Response("path and bytes are required", { status: 400 });
        }
        return uploadFile(store, body.path, body.bytes, body.mimetype);
      },

      DELETE: async ({ request }) => {
        const body = (await request.json()) as { path: string };
        if (!body.path) {
          return new Response("path is required", { status: 400 });
        }
        return removeFile(store, body.path);
      },
    },
  },
});

export { getFile, putFile, deleteFile };
