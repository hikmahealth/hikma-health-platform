/**
 * Super-admin server functions backing the File Storage settings section.
 *
 * Secrets only travel inwards: reads report whether a secret is set, never
 * what it is, and errors reaching the browser are truncated and scrubbed of
 * the credentials that produced them.
 */

import { randomBytes } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { v7 as uuidV7 } from "uuid";
import { Logger } from "@hikmahealth/js-utils";
import db from "@/db";
import { superAdminMiddleware } from "@/middleware/auth";
import ServerVariable from "@/models/server_variable";
import { logAuditEvent } from "@/lib/server-functions/audit";
import { resolveConfig } from "@/storage/adapters/base";
import {
  configFieldsFor,
  createAdapter,
  getConfiguredStoreType,
  invalidateAdapterCache,
  storesOwningSecret,
} from "@/storage/factory";
import type { ConfigField, StoreDescriptor, StoreType } from "@/storage/types";
import {
  STORE_DESCRIPTORS,
  SUPPORTED_STORES,
  isStoreType,
} from "@/storage/types";

/** One configuration field as the settings screen sees it. */
export type StorageFieldView = {
  key: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  secret: boolean;
  valueType: "string" | "json";
  /** Always "" for a secret field — secret values never leave the server. */
  value: string;
  isSet: boolean;
  /**
   * Whether the settings screen may offer to remove this credential. False
   * unless the field is a secret that is set and no backend still needs it —
   * `deleteStorageSecret` enforces the same rule, this only hides the button.
   */
  removable: boolean;
};

export type StorageSettingsView = {
  storeType: StoreType;
  stores: readonly StoreDescriptor[];
  /** Fields for every backend, so switching the dropdown needs no round trip. */
  fieldsByStore: Record<StoreType, readonly StorageFieldView[]>;
};

export type StorageProbeStep =
  | "connect"
  | "ensure"
  | "put"
  | "get"
  | "delete";

export type StorageProbeResult = {
  ok: boolean;
  step: StorageProbeStep;
  message: string;
  latencyMs: number;
};

const PROBE_PREFIX = "hh_storage_probe";
const PROBE_MIMETYPE = "application/octet-stream";
const ERROR_MESSAGE_LIMIT = 300;

const everyConfigKey = (): readonly string[] => [
  ...new Set(
    SUPPORTED_STORES.flatMap((store) =>
      configFieldsFor(store).map((field) => field.key),
    ),
  ),
];

const toFieldView = (
  field: ConfigField,
  stored: Readonly<Record<string, string | null>>,
  storeIsInUse: boolean,
): StorageFieldView => {
  const storedValue = stored[field.key] ?? "";
  return {
    key: field.key,
    label: field.label,
    description: field.description ?? null,
    placeholder: field.placeholder ?? null,
    required: field.required,
    secret: field.secret,
    valueType: field.valueType,
    value: field.secret ? "" : storedValue || (field.default ?? ""),
    isSet: storedValue !== "",
    removable: field.secret && storedValue !== "" && !storeIsInUse,
  };
};

/**
 * Backends whose credentials must be kept: the active one, plus any that still
 * owns a `resources` row. Dropping a credential for a backend that owns rows
 * makes those files unreadable — which for form attachments means PHI a
 * clinician can no longer retrieve.
 *
 * Soft-deleted rows count. The read routes serve a resource without checking
 * `deleted_at`, and a stuck credential is a far cheaper mistake than an
 * unreadable one.
 *
 * One `LIMIT 1` seek per candidate against `store_type_ix`, not
 * `SELECT DISTINCT store`: `resources` holds every attachment ever uploaded
 * and grows without bound, while `store` has five values — Postgres will not
 * skip-scan that, so a distinct is a full scan. This runs in the settings-page
 * loader, so it has to stay logarithmic.
 */
const storesInUse = async (
  active: StoreType,
  candidates: readonly StoreType[] = SUPPORTED_STORES,
): Promise<ReadonlySet<StoreType>> => {
  const owners = await Promise.all(
    candidates.map(async (store) => {
      const row = await db
        .selectFrom("resources")
        .select("id")
        .where("store", "=", store)
        .limit(1)
        .executeTakeFirst();
      return row === undefined ? null : store;
    }),
  );

  return new Set<StoreType>([
    active,
    ...owners.filter((store): store is StoreType => store !== null),
  ]);
};

const storeLabel = (store: StoreType): string =>
  STORE_DESCRIPTORS.find((entry) => entry.store === store)?.label ?? store;

export const getStorageSettings = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async (): Promise<StorageSettingsView> => {
    const storeType = await getConfiguredStoreType();
    const [stored, inUse] = await Promise.all([
      ServerVariable.getManyAsStrings(everyConfigKey()),
      storesInUse(storeType),
    ]);

    const fieldsByStore = {} as Record<
      StoreType,
      readonly StorageFieldView[]
    >;
    for (const store of SUPPORTED_STORES) {
      fieldsByStore[store] = configFieldsFor(store).map((field) =>
        toFieldView(field, stored, inUse.has(store)),
      );
    }

    return {
      storeType,
      stores: STORE_DESCRIPTORS,
      fieldsByStore,
    };
  });

/**
 * Values the admin typed, merged over what is already stored. Blank entries
 * mean "leave as is", which is how an unchanged secret input round-trips.
 */
type SubmittedValues = Record<string, string>;

const assertKnownKeys = (
  fields: readonly ConfigField[],
  values: SubmittedValues,
): void => {
  const allowed = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown storage configuration field: ${key}`);
    }
  }
};

const assertParsableJson = (
  fields: readonly ConfigField[],
  values: SubmittedValues,
): void => {
  for (const field of fields) {
    const value = values[field.key];
    if (field.valueType !== "json" || value === undefined || value === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${field.label} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${field.label} must be a JSON object`);
    }
  }
};

/**
 * Redact any credential that leaked into a provider's error string, then cap
 * its length. Short values are skipped — redacting them would mangle
 * unrelated text without protecting anything.
 */
const sanitizeErrorMessage = (
  error: unknown,
  secrets: readonly string[],
): string => {
  const raw = error instanceof Error ? error.message : String(error);
  let message = raw;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      message = message.split(secret).join("[redacted]");
    }
  }
  return message.slice(0, ERROR_MESSAGE_LIMIT);
};

const secretValuesOf = (
  fields: readonly ConfigField[],
  config: Readonly<Record<string, string | undefined>>,
): readonly string[] =>
  fields
    .filter((field) => field.secret)
    .map((field) => config[field.key])
    .filter((value): value is string => value !== undefined && value !== "");

export const saveStorageSettings = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { storeType: string; values: SubmittedValues }) => data,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    if (!isStoreType(data.storeType)) {
      throw new Error(`Unsupported storage type: ${data.storeType}`);
    }
    const storeType = data.storeType;
    const fields = configFieldsFor(storeType);

    assertKnownKeys(fields, data.values);
    assertParsableJson(fields, data.values);

    const stored = await ServerVariable.getManyAsStrings(
      fields.map((field) => field.key),
    );
    // Throws unless every required field is submitted or already stored.
    resolveConfig(fields, stored, data.values);

    const changedKeys: string[] = [];
    for (const field of fields) {
      const submitted = data.values[field.key];
      if (submitted === undefined || submitted === "") continue;
      if (submitted === stored[field.key]) continue;

      if (field.valueType === "json") {
        await ServerVariable.setJson(
          field.key,
          JSON.parse(submitted),
          field.label,
        );
      } else {
        await ServerVariable.setString(field.key, submitted, field.label);
      }
      changedKeys.push(field.key);
    }

    // Written last, so a partial failure leaves the active store pointing at
    // the backend that is still fully configured.
    await ServerVariable.setString(
      ServerVariable.Keys.HH_STORE_TYPE,
      storeType,
      "Active file storage backend",
    );
    invalidateAdapterCache();

    if (context.userId) {
      await logAuditEvent({
        actionType: "UPDATE",
        tableName: "server_variables",
        rowId: ServerVariable.Keys.HH_STORE_TYPE,
        // Key names only — some of these values are credentials.
        changes: { store_type: storeType, changed_keys: changedKeys },
        userId: context.userId,
      });
    }

    return { ok: true };
  });

export const testStorageConnection = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { storeType: string; values: SubmittedValues }) => data,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data }): Promise<StorageProbeResult> => {
    if (!isStoreType(data.storeType)) {
      throw new Error(`Unsupported storage type: ${data.storeType}`);
    }
    const storeType = data.storeType;
    const fields = configFieldsFor(storeType);

    assertKnownKeys(fields, data.values);
    assertParsableJson(fields, data.values);

    const started = Date.now();
    let step: StorageProbeStep = "connect";
    let secrets: readonly string[] = Object.values(data.values);

    try {
      const stored = await ServerVariable.getManyAsStrings(
        fields.map((field) => field.key),
      );
      const config = resolveConfig(fields, stored, data.values);
      secrets = [...secrets, ...secretValuesOf(fields, config)];

      const adapter = await createAdapter(storeType, config);

      step = "ensure";
      await adapter.ensureContainer();

      const destination = `${PROBE_PREFIX}/${uuidV7()}`;
      const payload = new Uint8Array(randomBytes(32));

      step = "put";
      await adapter.put(payload, destination, PROBE_MIMETYPE);

      step = "get";
      const readBack = await adapter.downloadAsBytes(destination);
      const identical =
        readBack.byteLength === payload.byteLength &&
        readBack.every((byte, index) => byte === payload[index]);

      step = "delete";
      await adapter.delete(destination);

      if (!identical) {
        return {
          ok: false,
          step: "get",
          message: "The file read back did not match the file written.",
          latencyMs: Date.now() - started,
        };
      }

      return {
        ok: true,
        step: "delete",
        message: "Connected. Wrote, read back and removed a test file.",
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      Logger.error({
        msg: "[storage-settings] connection test failed",
        store: storeType,
        step,
        error,
      });
      return {
        ok: false,
        step,
        message: sanitizeErrorMessage(error, secrets),
        latencyMs: Date.now() - started,
      };
    }
  });

export const deleteStorageSecret = createServerFn({ method: "POST" })
  .inputValidator((data: { key: string }) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const owningStores = storesOwningSecret(data.key);
    if (owningStores.length === 0) {
      throw new Error(`Unknown storage credential: ${data.key}`);
    }

    // Being inactive is not enough. A backend that is no longer written to
    // still serves every file uploaded while it was active, and this
    // credential is the only way to read them.
    const activeStore = await getConfiguredStoreType();
    const inUse = await storesInUse(activeStore, owningStores);
    const blocked = owningStores.filter((store) => inUse.has(store));
    if (blocked.length > 0) {
      throw new Error(
        blocked.includes(activeStore)
          ? "This credential belongs to the active storage backend. Switch backends before removing it."
          : `Files are still stored in ${blocked.map(storeLabel).join(" and ")}. Removing this credential would make them unreadable.`,
      );
    }

    await ServerVariable.clearValue(data.key);
    invalidateAdapterCache();

    if (context.userId) {
      await logAuditEvent({
        actionType: "PERMANENT_DELETE",
        tableName: "server_variables",
        rowId: data.key,
        changes: { key: data.key },
        userId: context.userId,
      });
    }

    return { ok: true };
  });
