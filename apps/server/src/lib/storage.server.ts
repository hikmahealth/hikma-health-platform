import { type StoreManager } from "@hikmahealth/storage-server";
import { DiskStoreManager } from "@hikmahealth/storage-server/options";
import {
  downloadFile,
  uploadFile,
  removeFile,
} from "@hikmahealth/storage-server/serve/node";
import { createServerFn } from "@tanstack/react-start";

export const store = new DiskStoreManager({ dir: "/files" });
const manager: StoreManager = store;

export const getFile = createServerFn({ method: "GET" })
  .inputValidator((data: { path: string }) => data)
  .handler(({ data }) => downloadFile(manager, data.path));

export const putFile = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { path: string; bytes: number[]; mimetype?: string }) => data,
  )
  .handler(({ data }) =>
    uploadFile(manager, data.path, data.bytes, data.mimetype),
  );

export const deleteFile = createServerFn({ method: "POST" })
  .inputValidator((data: { path: string }) => data)
  .handler(({ data }) => removeFile(manager, data.path));
