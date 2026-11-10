import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  checkHersConnection,
  createHersCredentials,
  registerHersClinicLocation,
  registerHersWebhook,
  removeHersCredentials,
  saveExistingHersCredentials,
  unregisterHersClinicLocation,
  type HersClinicView,
  type HersConnectionView,
  type HersFeature,
  type HersSettingsView,
} from "@/lib/server-functions/hers";

const FEATURE_LABELS: Record<HersFeature, string> = {
  temperature: "Temperature",
  pm_2_5: "PM2.5 air quality",
};

const errorMessage = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

const formatDate = (iso: string) => new Date(iso).toLocaleString();

type Props = {
  settings: HersSettingsView;
  onChanged: () => Promise<unknown>;
};

/**
 * Settings for HERS environmental monitoring: the client credentials, the
 * webhook that receives anomaly events, and which clinic locations are
 * monitored. The webhook and locations only appear once a client exists.
 */
export function HersMonitoringSection({ settings, onChanged }: Props) {
  return (
    <div className="flex flex-col gap-6 pt-4 border-t">
      <div>
        <h2 className="text-lg font-semibold">HERS monitoring</h2>
        <div className="text-sm text-muted-foreground">
          Monitor environmental conditions (heat, air quality) around your
          clinics with the HERS service. When HERS detects an anomaly, the
          patients most affected are classified for environmental health risk.
        </div>
      </div>

      <CredentialsPanel settings={settings} onChanged={onChanged} />
      {settings.credentials.isSet && (
        <>
          <WebhookPanel settings={settings} onChanged={onChanged} />
          <LocationsPanel settings={settings} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

function StepHeading({ step, title }: { step: number; title: string }) {
  return (
    <h3 className="font-medium">
      {step}. {title}
    </h3>
  );
}

function CredentialsPanel({ settings, onChanged }: Props) {
  const { credentials } = settings;
  const [isEditing, setIsEditing] = useState(false);
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [baseUrl, setBaseUrl] = useState(
    credentials.isSet ? credentials.baseUrl : settings.defaultBaseUrl,
  );
  const [name, setName] = useState("hikma-health");
  const [clientId, setClientId] = useState("");
  const [signingKey, setSigningKey] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [connection, setConnection] = useState<HersConnectionView | null>(null);

  const showForm = !credentials.isSet || isEditing;

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setIsBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e, fallback));
    } finally {
      setIsBusy(false);
    }
  };

  const startEditing = () => {
    if (credentials.isSet) setBaseUrl(credentials.baseUrl);
    setClientId("");
    setSigningKey("");
    setIsEditing(true);
  };

  const finishEditing = () => {
    setSigningKey("");
    setConnection(null);
    setIsEditing(false);
  };

  const confirmReplace = () =>
    !credentials.isSet ||
    window.confirm(
      "Replacing the HERS client forgets the current webhook and registered clinic locations on this server. Continue?",
    );

  const handleCreate = () => {
    if (!confirmReplace()) return;
    return run(async () => {
      const { clientId } = await createHersCredentials({
        data: { baseUrl, name },
      });
      toast.success(`HERS client ${clientId} created`);
      finishEditing();
      await onChanged();
    }, "Failed to create HERS credentials");
  };

  const handleSaveExisting = () => {
    if (!confirmReplace()) return;
    return run(async () => {
      await saveExistingHersCredentials({
        data: { baseUrl, clientId, signingKey },
      });
      toast.success("HERS credentials verified and saved");
      finishEditing();
      await onChanged();
    }, "Failed to save HERS credentials");
  };

  const handleCheck = () =>
    run(async () => {
      setConnection(await checkHersConnection());
    }, "Failed to reach HERS");

  const handleRemove = () => {
    if (
      !window.confirm(
        "Remove the HERS credentials, webhook and clinic locations from this server? Monitoring stops reaching this server.",
      )
    )
      return;
    return run(async () => {
      await removeHersCredentials();
      toast.success("HERS credentials removed");
      finishEditing();
      await onChanged();
    }, "Failed to remove HERS credentials");
  };

  return (
    <div className="flex flex-col gap-3">
      <StepHeading step={1} title="Credentials" />

      {credentials.isSet && (
        <div className="flex flex-col gap-3">
          <div className="text-sm">
            Connected to{" "}
            <span className="font-medium">{credentials.baseUrl}</span> as client{" "}
            <span className="font-mono">{credentials.clientId}</span>. The
            signing key is stored on this server.
          </div>
          {!isEditing && (
            <div className="flex flex-row gap-3">
              <Button
                variant="outline"
                onClick={startEditing}
                disabled={isBusy}
              >
                Edit
              </Button>
              <Button variant="outline" onClick={handleCheck} disabled={isBusy}>
                Test connection
              </Button>
              <Button
                variant="outline"
                onClick={handleRemove}
                disabled={isBusy}
              >
                Remove credentials
              </Button>
            </div>
          )}
          {connection && <ConnectionResult connection={connection} />}
        </div>
      )}

      {!credentials.isSet && (
        <div className="text-sm text-muted-foreground">
          Create a HERS client to start monitoring. The webhook and clinic
          locations are set up once the client exists.
        </div>
      )}

      {showForm && (
        <div className="flex flex-col gap-3 rounded-md border p-4">
          <div className="flex flex-row gap-2">
            <Button
              size="sm"
              variant={mode === "create" ? "default" : "outline"}
              onClick={() => setMode("create")}
            >
              Create new client
            </Button>
            <Button
              size="sm"
              variant={mode === "existing" ? "default" : "outline"}
              onClick={() => setMode("existing")}
            >
              Use existing client
            </Button>
          </div>

          <Input
            label="HERS URL"
            description="The address of the HERS service"
            placeholder="https://hers.example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="lg:w-md"
          />

          {mode === "create" ? (
            <Input
              label="Client name"
              description="How this server is identified in HERS"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="lg:w-md"
            />
          ) : (
            <>
              <Input
                label="Client ID"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                className="lg:w-md"
              />
              <Input
                label="Signing key"
                description="Base64 PKCS#8 Ed25519 private key issued by HERS"
                type="password"
                value={signingKey}
                onChange={(e) => setSigningKey(e.target.value)}
                autoComplete="new-password"
                className="lg:w-md"
              />
            </>
          )}

          <div className="flex flex-row gap-3">
            {mode === "create" ? (
              <Button
                onClick={handleCreate}
                disabled={isBusy || !baseUrl.trim() || !name.trim()}
              >
                {credentials.isSet
                  ? "Replace with new client"
                  : "Create credentials"}
              </Button>
            ) : (
              <Button
                onClick={handleSaveExisting}
                disabled={
                  isBusy ||
                  !baseUrl.trim() ||
                  !clientId.trim() ||
                  !signingKey.trim()
                }
              >
                Verify and save
              </Button>
            )}
            {isEditing && (
              <Button
                variant="outline"
                onClick={finishEditing}
                disabled={isBusy}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionResult({ connection }: { connection: HersConnectionView }) {
  if (!connection.ok) {
    return <div className="text-sm text-destructive">{connection.message}</div>;
  }
  const { client, subscriptions } = connection;
  return (
    <div className="text-sm flex flex-col gap-1">
      <div>
        Status: <span className="font-medium">{client.status}</span>
        {client.name ? ` — ${client.name}` : ""}
      </div>
      <div>
        Scopes: {client.scope.length > 0 ? client.scope.join(", ") : "none"}
        {!client.scope.includes("ems") && (
          <span className="text-destructive">
            {" "}
            (missing "ems": locations can't be registered)
          </span>
        )}
        {!client.scope.includes("hers") && (
          <span className="text-destructive">
            {" "}
            (missing "hers": patients can't be classified)
          </span>
        )}
      </div>
      <div>Locations monitored on HERS: {subscriptions.length}</div>
    </div>
  );
}

function WebhookPanel({ settings, onChanged }: Props) {
  const { webhook } = settings;
  const [isEditing, setIsEditing] = useState(false);
  const [url, setUrl] = useState(
    webhook?.url ?? settings.suggestedWebhookUrl ?? "",
  );
  const [isBusy, setIsBusy] = useState(false);

  const showForm = !webhook || isEditing;

  const startEditing = () => {
    setUrl(webhook?.url ?? settings.suggestedWebhookUrl ?? "");
    setIsEditing(true);
  };

  const handleRegister = async () => {
    setIsBusy(true);
    try {
      await registerHersWebhook({ data: { webhookUrl: url } });
      toast.success(webhook ? "Webhook updated" : "Webhook registered");
      setIsEditing(false);
      await onChanged();
    } catch (e) {
      toast.error(errorMessage(e, "Failed to register the webhook"));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <StepHeading step={2} title="Anomaly webhook" />
      <div className="text-sm text-muted-foreground">
        HERS calls this URL when it detects an environmental anomaly at a
        monitored clinic. It must be reachable from the internet.
      </div>

      {webhook && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 text-sm">
            <div>
              URL: <span className="font-mono">{webhook.url}</span>
            </div>
            <div>Events: {webhook.events.join(", ")}</div>
            <div>Registered: {formatDate(webhook.registeredAt)}</div>
          </div>
          {!isEditing && (
            <div>
              <Button variant="outline" onClick={startEditing}>
                Edit
              </Button>
            </div>
          )}
        </div>
      )}

      {showForm && (
        <div className="flex flex-col gap-3 rounded-md border p-4">
          <Input
            label="Webhook URL"
            description={
              settings.suggestedWebhookUrl
                ? webhook
                  ? "Saving registers this URL again and rotates the signing secret."
                  : undefined
                : "SERVER_URL is not set, so the URL can't be suggested. Enter this server's public address followed by /api/hers/webhook."
            }
            placeholder="https://ehr.example.com/api/hers/webhook"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="lg:w-xl"
          />
          <div className="flex flex-row gap-3">
            <Button onClick={handleRegister} disabled={isBusy || !url.trim()}>
              {webhook ? "Save" : "Register webhook"}
            </Button>
            {isEditing && (
              <Button
                variant="outline"
                onClick={() => setIsEditing(false)}
                disabled={isBusy}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type LocationDraft = {
  latitude: string;
  longitude: string;
  features: HersFeature[];
  forecastDays: string;
  duration: string;
};

const draftFor = (
  clinic: HersClinicView,
  features: readonly HersFeature[],
): LocationDraft => ({
  latitude: clinic.location ? String(clinic.location.latitude) : "",
  longitude: clinic.location ? String(clinic.location.longitude) : "",
  features: clinic.location?.features ?? [...features],
  forecastDays: String(clinic.location?.forecast_days ?? 3),
  duration: clinic.location?.duration ?? "",
});

function LocationsPanel({ settings, onChanged }: Props) {
  const [target, setTarget] = useState<HersClinicView | null>(null);
  const [draft, setDraft] = useState<LocationDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const openDialog = (clinic: HersClinicView) => {
    setTarget(clinic);
    setDraft(draftFor(clinic, settings.features));
  };

  const closeDialog = () => {
    setTarget(null);
    setDraft(null);
  };

  const updateDraft = (patch: Partial<LocationDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const toggleFeature = (feature: HersFeature, checked: boolean) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            features: checked
              ? [...new Set([...d.features, feature])]
              : d.features.filter((f) => f !== feature),
          }
        : d,
    );

  const handleSave = async () => {
    if (!target || !draft) return;
    const latitude = Number(draft.latitude);
    const longitude = Number(draft.longitude);
    const forecastDays = Number(draft.forecastDays);
    if (
      draft.latitude.trim() === "" ||
      draft.longitude.trim() === "" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      toast.error("Enter a valid latitude and longitude");
      return;
    }
    if (
      !Number.isInteger(forecastDays) ||
      forecastDays < 1 ||
      forecastDays > 7
    ) {
      toast.error("Forecast days must be a whole number from 1 to 7");
      return;
    }

    setIsSaving(true);
    try {
      await registerHersClinicLocation({
        data: {
          clinicId: target.id,
          latitude,
          longitude,
          features: draft.features,
          forecastDays,
          duration: draft.duration.trim() || null,
        },
      });
      toast.success(
        target.location
          ? `${target.name} updated`
          : `${target.name} registered for monitoring`,
      );
      closeDialog();
      await onChanged();
    } catch (e) {
      toast.error(errorMessage(e, "Failed to register the clinic location"));
    } finally {
      setIsSaving(false);
    }
  };

  const handleUnregister = async (clinic: HersClinicView) => {
    if (!window.confirm(`Stop environmental monitoring for ${clinic.name}?`))
      return;
    setRemovingId(clinic.id);
    try {
      await unregisterHersClinicLocation({ data: { clinicId: clinic.id } });
      toast.success(`${clinic.name} unregistered`);
      await onChanged();
    } catch (e) {
      toast.error(errorMessage(e, "Failed to unregister the clinic location"));
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <StepHeading step={3} title="Clinic locations" />
      <div className="text-sm text-muted-foreground">
        Choose which clinics HERS monitors, and where they are.
      </div>

      {settings.clinics.length === 0 ? (
        <div className="text-sm text-muted-foreground">No clinics yet.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Clinic</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Monitoring</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {settings.clinics.map((clinic) => {
              const { location } = clinic;
              return (
                <TableRow key={clinic.id}>
                  <TableCell className="font-medium">{clinic.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {location
                      ? `${location.latitude}, ${location.longitude}`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {location ? (
                      <div className="flex flex-row flex-wrap gap-1">
                        {location.features.map((feature) => (
                          <Badge key={feature} variant="secondary">
                            {FEATURE_LABELS[feature]}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        Not monitored
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-row justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openDialog(clinic)}
                        disabled={removingId === clinic.id}
                      >
                        {location ? "Edit" : "Register"}
                      </Button>
                      {location && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleUnregister(clinic)}
                          disabled={removingId === clinic.id}
                        >
                          Unregister
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !isSaving) closeDialog();
        }}
      >
        {target && draft && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {target.location ? "Edit" : "Register"} {target.name}
              </DialogTitle>
              <DialogDescription>
                Where this clinic is, and what HERS should watch for there.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex flex-row gap-4">
                <Input
                  label="Latitude"
                  placeholder="-6.8"
                  inputMode="decimal"
                  value={draft.latitude}
                  onChange={(e) => updateDraft({ latitude: e.target.value })}
                />
                <Input
                  label="Longitude"
                  placeholder="39.2"
                  inputMode="decimal"
                  value={draft.longitude}
                  onChange={(e) => updateDraft({ longitude: e.target.value })}
                />
              </div>

              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium">Monitor</div>
                {settings.features.map((feature) => (
                  <Checkbox
                    key={feature}
                    label={FEATURE_LABELS[feature]}
                    checked={draft.features.includes(feature)}
                    onCheckedChange={(checked) =>
                      toggleFeature(feature, checked === true)
                    }
                  />
                ))}
              </div>

              <div className="flex flex-row gap-4">
                <Input
                  label="Forecast days"
                  description="Days ahead to check (1-7)"
                  type="number"
                  min={1}
                  max={7}
                  value={draft.forecastDays}
                  onChange={(e) =>
                    updateDraft({ forecastDays: e.target.value })
                  }
                />
                <Input
                  label="Duration"
                  description="e.g. 7d or 2w. Empty monitors indefinitely"
                  placeholder="Indefinitely"
                  value={draft.duration}
                  onChange={(e) => updateDraft({ duration: e.target.value })}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeDialog}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={isSaving || draft.features.length === 0}
              >
                {target.location ? "Update" : "Register"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
