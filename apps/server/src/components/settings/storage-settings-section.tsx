import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectInput } from "@/components/select-input";
import {
  deleteStorageSecret,
  saveStorageSettings,
  testStorageConnection,
  type StorageFieldView,
  type StorageProbeResult,
  type StorageSettingsView,
} from "@/lib/server-functions/storage-settings";

type StoreType = StorageSettingsView["storeType"];

/** Non-secret fields start from their stored value; secret fields start blank. */
const initialDrafts = (
  fields: readonly StorageFieldView[],
): Record<string, string> => {
  const drafts: Record<string, string> = {};
  for (const field of fields) {
    drafts[field.key] = field.secret ? "" : field.value;
  }
  return drafts;
};

/**
 * Identifies which configuration a successful test applies to, so a passing
 * probe can never authorise saving a different one.
 */
const configSignature = (
  store: StoreType,
  fields: readonly StorageFieldView[],
  drafts: Record<string, string>,
): string =>
  JSON.stringify([store, fields.map((field) => drafts[field.key] ?? "")]);

const secretDescription = (field: StorageFieldView): string | undefined => {
  if (!field.secret) return field.description ?? undefined;
  const prefix = field.isSet
    ? "A value is currently set. Enter a new value to replace it."
    : "";
  return [prefix, field.description ?? ""].filter(Boolean).join(" ") || undefined;
};

export function StorageSettingsSection({
  settings,
  onSaved,
}: {
  settings: StorageSettingsView;
  onSaved: () => void;
}) {
  const [store, setStore] = useState<StoreType>(settings.storeType);
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    initialDrafts(settings.fieldsByStore[settings.storeType] ?? []),
  );
  const [probe, setProbe] = useState<StorageProbeResult | null>(null);
  const [probedSignature, setProbedSignature] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fields = settings.fieldsByStore[store] ?? [];
  const signature = useMemo(
    () => configSignature(store, fields, drafts),
    [store, fields, drafts],
  );
  const isTested = probe?.ok === true && probedSignature === signature;
  const isSwitching = store !== settings.storeType;

  const activeLabel =
    settings.stores.find((entry) => entry.store === settings.storeType)
      ?.label ?? settings.storeType;
  const selected = settings.stores.find((entry) => entry.store === store);

  const handleStoreChange = (value: string | null) => {
    if (!value) return;
    const next = value as StoreType;
    setStore(next);
    setDrafts(initialDrafts(settings.fieldsByStore[next] ?? []));
    setProbe(null);
    setProbedSignature(null);
  };

  const handleFieldChange = (key: string, value: string) => {
    setDrafts((current) => ({ ...current, [key]: value }));
    setProbe(null);
    setProbedSignature(null);
  };

  // Blank entries are dropped so an untouched secret input means "keep the
  // stored value" rather than "clear it".
  const submittedValues = (): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const field of fields) {
      const value = drafts[field.key] ?? "";
      if (value !== "") values[field.key] = value;
    }
    return values;
  };

  const handleTest = () => {
    setIsTesting(true);
    const tested = signature;
    testStorageConnection({ data: { storeType: store, values: submittedValues() } })
      .then((result) => {
        setProbe(result);
        setProbedSignature(result.ok ? tested : null);
        if (result.ok) {
          toast.success(`Storage connection verified in ${result.latencyMs} ms`);
        }
      })
      .catch((error: Error) => {
        setProbe(null);
        setProbedSignature(null);
        toast.error(`Connection test failed: ${error.message}`);
      })
      .finally(() => setIsTesting(false));
  };

  const handleRemoveSecret = (field: StorageFieldView) => {
    deleteStorageSecret({ data: { key: field.key } })
      .then(() => {
        toast.success(`${field.label} removed`);
        setProbe(null);
        setProbedSignature(null);
        onSaved();
      })
      .catch((error: Error) => {
        toast.error(`Failed to remove ${field.label}: ${error.message}`);
      });
  };

  const handleSave = () => {
    setIsSaving(true);
    saveStorageSettings({ data: { storeType: store, values: submittedValues() } })
      .then(() => {
        toast.success("Storage settings saved");
        setProbe(null);
        setProbedSignature(null);
        onSaved();
      })
      .catch((error: Error) => {
        toast.error(`Failed to save storage settings: ${error.message}`);
      })
      .finally(() => setIsSaving(false));
  };

  return (
    <div className="flex flex-col gap-4 pt-4 border-t">
      <h2 className="text-lg font-semibold">File Storage</h2>
      <div className="text-sm text-muted-foreground">
        Where uploaded files, form attachments and educational content are
        stored. New uploads go to the backend selected here; files that were
        already uploaded keep being served from wherever they were originally
        stored. Currently active: <strong>{activeLabel}</strong>.
      </div>

      <SelectInput
        label="Storage provider"
        description={selected?.description}
        value={store}
        onChange={handleStoreChange}
        allowDeselect={false}
        className="lg:w-md"
        data={settings.stores.map((entry) => ({
          value: entry.store,
          label: entry.label,
        }))}
      />

      {isSwitching && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Saving will send new uploads to {selected?.label ?? store}. Existing
          files stay where they are and keep working — every backend keeps its
          own credentials, so {activeLabel} stays readable.
        </div>
      )}

      <div className="flex flex-col gap-4">
        {fields.map((field) => (
          <div key={field.key} className="flex flex-row gap-4 items-end">
            {field.valueType === "json" ? (
              <Textarea
                label={field.label}
                description={secretDescription(field)}
                required={field.required}
                rows={6}
                placeholder={
                  field.isSet
                    ? "A value is currently set"
                    : (field.placeholder ?? "")
                }
                value={drafts[field.key] ?? ""}
                onChange={(event) =>
                  handleFieldChange(field.key, event.target.value)
                }
                className="lg:w-2xl font-mono text-xs"
              />
            ) : (
              <Input
                label={field.label}
                description={secretDescription(field)}
                required={field.required}
                type={field.secret ? "password" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                placeholder={
                  field.secret && field.isSet
                    ? "••••••••"
                    : (field.placeholder ?? "")
                }
                value={drafts[field.key] ?? ""}
                onChange={(event) =>
                  handleFieldChange(field.key, event.target.value)
                }
                className="lg:w-md"
              />
            )}
            {/* Server-computed: a credential is removable only when no
                backend still needs it to read files it already holds. */}
            {field.removable && (
              <Button
                variant="outline"
                onClick={() => handleRemoveSecret(field)}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
      </div>

      {probe && (
        <div
          className={`rounded-md border p-3 text-sm ${
            probe.ok
              ? "border-emerald-500/40 bg-emerald-500/10"
              : "border-destructive/40 bg-destructive/10"
          }`}
        >
          {probe.ok
            ? `Connected in ${probe.latencyMs} ms. ${probe.message}`
            : `Failed at step "${probe.step}": ${probe.message}`}
        </div>
      )}

      <div className="flex flex-row gap-4 items-center">
        <Button variant="outline" onClick={handleTest} disabled={isTesting}>
          {isTesting ? "Testing…" : "Test connection"}
        </Button>
        <Button onClick={handleSave} disabled={!isTested || isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
        {!isTested && (
          <span className="text-sm text-muted-foreground">
            Test the connection before saving.
          </span>
        )}
      </div>
    </div>
  );
}
