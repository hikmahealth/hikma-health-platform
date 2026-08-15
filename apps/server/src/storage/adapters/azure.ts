import type { StorageAdapter } from "./base.ts";
import { httpStatusOf, validatePut } from "./base.ts";
import type { ConfigField, PutOutput } from "../types.ts";
import { ResourceOperationError } from "../errors.ts";

export type AzureAdapterConfig = {
  connectionString: string;
  containerName: string;
};

export const azureConfigFields: readonly ConfigField[] = [
  {
    key: "azure_storage_connection_string",
    label: "Connection string",
    description:
      "The storage-account connection string from the Azure portal, under Access keys.",
    required: true,
    secret: true,
    valueType: "string",
  },
  {
    key: "azure_container_name",
    label: "Container name",
    required: false,
    secret: false,
    valueType: "string",
    default: "hikmahealth",
  },
] as const;

export const createAzureAdapter = async (
  config: AzureAdapterConfig,
): Promise<StorageAdapter> => {
  const { BlobServiceClient } = await import("@azure/storage-blob");

  const serviceClient = BlobServiceClient.fromConnectionString(
    config.connectionString,
  );
  const containerClient = serviceClient.getContainerClient(
    config.containerName,
  );

  return {
    name: "azure",
    version: "azure.202603.01",

    async ensureContainer(): Promise<void> {
      try {
        await containerClient.createIfNotExists();
      } catch (error) {
        // createIfNotExists only swallows ContainerAlreadyExists, so a
        // container-scoped SAS credential is denied here on a usable container.
        if (httpStatusOf(error) === 403) return;
        throw new ResourceOperationError("ensureContainer", error);
      }
    },

    async put(
      data: Uint8Array,
      destination: string,
      mimetype?: string,
    ): Promise<PutOutput> {
      validatePut(data, mimetype);
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(destination);
        const response = await blockBlobClient.upload(data, data.length, {
          blobHTTPHeaders: {
            blobContentType: mimetype ?? "application/octet-stream",
          },
        });
        // Azure returns contentMD5 only when the service computed one.
        const md5 = response.contentMD5
          ? Buffer.from(response.contentMD5).toString("hex")
          : "";
        return {
          uri: destination,
          hash: md5 === "" ? (["none", ""] as const) : (["md5", md5] as const),
        };
      } catch (error) {
        throw new ResourceOperationError("put", error);
      }
    },

    async delete(uri: string): Promise<void> {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(uri);
        await blockBlobClient.deleteIfExists();
      } catch (error) {
        throw new ResourceOperationError("delete", error);
      }
    },

    async downloadAsBytes(uri: string): Promise<Uint8Array> {
      try {
        const blockBlobClient = containerClient.getBlockBlobClient(uri);
        const buffer = await blockBlobClient.downloadToBuffer();
        return new Uint8Array(buffer);
      } catch (error) {
        throw new ResourceOperationError("downloadAsBytes", error);
      }
    },
  };
};
