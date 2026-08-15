import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  storeType: null as string | null,
  values: {} as Record<string, string | null>,
}));

vi.mock("@/models/server_variable.ts", () => ({
  default: {
    Keys: { HH_STORE_TYPE: "hh_store_type" },
    getAsString: async (key: string) =>
      key === "hh_store_type" ? state.storeType : null,
    getManyAsStrings: async (keys: readonly string[]) => {
      const values: Record<string, string | null> = {};
      for (const key of keys) values[key] = state.values[key] ?? null;
      return values;
    },
  },
}));

const {
  configFieldsFor,
  getAdapterForStore,
  getConfiguredAdapter,
  getConfiguredStoreType,
  invalidateAdapterCache,
  storesOwningSecret,
} = await import("@/storage/factory");
const { ResourceStoreUnavailableError } = await import("@/storage/errors");

const tigrisCredentials = {
  tigris_access_key_id: "tid_access_key",
  tigris_secret_access_key: "tsec_secret_key",
  tigris_bucket_name: "hikma-files",
};

const s3Credentials = {
  aws_access_key_id: "AKIAEXAMPLE",
  aws_secret_access_key: "aws_secret_value",
  s3_bucket_name: "hikma-s3-files",
};

beforeEach(() => {
  state.storeType = null;
  state.values = {};
  invalidateAdapterCache();
});

describe("getConfiguredStoreType", () => {
  it("defaults to disk when nothing is configured", async () => {
    await expect(getConfiguredStoreType()).resolves.toBe("disk");
  });

  it("returns the configured store", async () => {
    state.storeType = "tigris";
    await expect(getConfiguredStoreType()).resolves.toBe("tigris");
  });

  it("throws on an unrecognised store type", async () => {
    state.storeType = "dropbox";
    await expect(getConfiguredStoreType()).rejects.toThrow(
      /Unsupported storage type/,
    );
  });
});

describe("getAdapterForStore", () => {
  it("returns the named backend even when a different one is active", async () => {
    // This is what keeps files uploaded before a backend switch readable.
    state.storeType = "tigris";
    state.values = { ...tigrisCredentials };

    const adapter = await getAdapterForStore("disk");

    expect(adapter.name).toBe("disk");
    await expect(getConfiguredAdapter()).resolves.toHaveProperty(
      "name",
      "tigris",
    );
  });

  it("builds a tigris adapter from stored credentials", async () => {
    state.values = { ...tigrisCredentials };

    const adapter = await getAdapterForStore("tigris");

    expect(adapter.name).toBe("tigris");
    expect(adapter.version).toContain("tigris");
  });

  it("keeps both S3-compatible backends usable at the same time", async () => {
    // The regression this guards: the two backends once shared credential
    // keys, so configuring one overwrote the other and every resources row
    // written under the loser became unreadable.
    state.values = { ...tigrisCredentials, ...s3Credentials };

    const tigris = await getAdapterForStore("tigris");
    const s3 = await getAdapterForStore("s3");

    expect(tigris.name).toBe("tigris");
    expect(s3.name).toBe("s3");
  });

  it("does not read tigris credentials out of the AWS keys", async () => {
    // If a cross-read survived anywhere, this would build an adapter instead
    // of failing — and would then sign a Tigris key to s3.amazonaws.com.
    state.values = { ...s3Credentials, aws_endpoint_url_s3: "https://t3.storage.dev" };

    await expect(getAdapterForStore("tigris")).rejects.toBeInstanceOf(
      ResourceStoreUnavailableError,
    );
  });

  it("does not read AWS credentials out of the tigris keys", async () => {
    state.values = { ...tigrisCredentials };

    await expect(getAdapterForStore("s3")).rejects.toBeInstanceOf(
      ResourceStoreUnavailableError,
    );
  });

  it("reuses the cached adapter while the configuration is unchanged", async () => {
    state.values = { ...tigrisCredentials };

    const first = await getAdapterForStore("tigris");
    const second = await getAdapterForStore("tigris");

    expect(second).toBe(first);
  });

  it("rebuilds the adapter after the configuration changes", async () => {
    state.values = { ...tigrisCredentials };
    const first = await getAdapterForStore("tigris");

    state.values = { ...tigrisCredentials, tigris_bucket_name: "other-bucket" };
    const second = await getAdapterForStore("tigris");

    expect(second).not.toBe(first);
  });

  it("reports a backend with missing required config as unavailable", async () => {
    state.values = { tigris_access_key_id: "tid_access_key" };

    await expect(getAdapterForStore("tigris")).rejects.toBeInstanceOf(
      ResourceStoreUnavailableError,
    );
  });

  it("names the offending store on the unavailable error", async () => {
    await expect(getAdapterForStore("azure")).rejects.toMatchObject({
      store: "azure",
    });
  });
});

describe("configFieldsFor", () => {
  it("shares no configuration key between s3 and tigris", () => {
    // Two backends writing the same server_variables rows means saving one
    // silently destroys the other's credentials. Keep these disjoint.
    const s3Keys = new Set(configFieldsFor("s3").map((field) => field.key));
    const overlap = configFieldsFor("tigris")
      .map((field) => field.key)
      .filter((key) => s3Keys.has(key));

    expect(overlap).toEqual([]);
  });

  it("gives tigris an endpoint field that native s3 does not have", () => {
    const tigrisKeys = configFieldsFor("tigris").map((field) => field.key);
    const s3Keys = configFieldsFor("s3").map((field) => field.key);

    expect(tigrisKeys).toContain("tigris_endpoint_url");
    expect(s3Keys.some((key) => key.includes("endpoint"))).toBe(false);
  });

  it("defaults tigris to the documented endpoint and auto region", () => {
    const fields = configFieldsFor("tigris");
    const endpoint = fields.find((field) => field.key === "tigris_endpoint_url");
    const region = fields.find((field) => field.key === "tigris_region");

    expect(endpoint?.default).toBe("https://t3.storage.dev");
    expect(region?.default).toBe("auto");
  });

  it("marks every credential field as secret", () => {
    for (const [store, secretKeys] of [
      ["tigris", ["tigris_access_key_id", "tigris_secret_access_key"]],
      ["s3", ["aws_access_key_id", "aws_secret_access_key"]],
    ] as const) {
      const fields = configFieldsFor(store);
      for (const key of secretKeys) {
        expect(fields.find((field) => field.key === key)?.secret).toBe(true);
      }
    }
  });

  it("never defaults a bucket name in a globally-unique namespace", () => {
    // A shared default would either collide with a stranger's bucket or
    // silently create one nobody expected.
    for (const [store, key] of [
      ["s3", "s3_bucket_name"],
      ["tigris", "tigris_bucket_name"],
      ["gcp", "gcp_bucket_name"],
    ] as const) {
      const field = configFieldsFor(store).find(
        (entry) => entry.key === key,
      );
      expect(field?.required).toBe(true);
      expect(field?.default).toBeUndefined();
    }
  });

  it("offers a GCS bucket location so data residency can be pinned", () => {
    const field = configFieldsFor("gcp").find(
      (entry) => entry.key === "gcp_bucket_location",
    );

    expect(field).toBeDefined();
    expect(field?.required).toBe(false);
  });

  it("requires an explicit bucket before an s3 adapter can be built", async () => {
    // Guards the removed `hikmahealth-s3` default: a deployment that relied on
    // it is repaired by 20260815_storage_backend_config_continuity, not by a
    // silent fallback here.
    state.values = {
      aws_access_key_id: "key",
      aws_secret_access_key: "secret",
    };

    await expect(getAdapterForStore("s3")).rejects.toBeInstanceOf(
      ResourceStoreUnavailableError,
    );
  });

  it("gives every field a label so the settings screen can render it", () => {
    for (const store of ["disk", "s3", "tigris", "gcp", "azure"] as const) {
      for (const field of configFieldsFor(store)) {
        expect(field.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("storesOwningSecret", () => {
  it("names the backend a credential belongs to", () => {
    expect(storesOwningSecret("tigris_secret_access_key")).toEqual(["tigris"]);
    expect(storesOwningSecret("aws_secret_access_key")).toEqual(["s3"]);
    expect(storesOwningSecret("gcp_service_account")).toEqual(["gcp"]);
    expect(storesOwningSecret("azure_storage_connection_string")).toEqual([
      "azure",
    ]);
  });

  it("returns nothing for a non-secret field", () => {
    // Removal is only offered for credentials; a bucket name is edited, not
    // revoked.
    expect(storesOwningSecret("s3_bucket_name")).toEqual([]);
    expect(storesOwningSecret("disk_storage_path")).toEqual([]);
  });

  it("returns nothing for a key no backend declares", () => {
    expect(storesOwningSecret("anthropic_api_key")).toEqual([]);
  });

  it("gives every credential exactly one owning backend", () => {
    // getStorageSettings computes `removable` per store, so a secret key owned
    // by two backends would be reported removable by whichever one is idle
    // while the other still needs it. Keep ownership single.
    for (const store of ["disk", "s3", "tigris", "gcp", "azure"] as const) {
      for (const field of configFieldsFor(store)) {
        if (!field.secret) continue;
        expect(storesOwningSecret(field.key)).toEqual([store]);
      }
    }
  });
});
