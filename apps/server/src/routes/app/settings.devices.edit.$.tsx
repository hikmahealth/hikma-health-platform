import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import Device from "@/models/device";
import User from "@/models/user";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "@tanstack/react-router";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MultiSelect } from "@/components/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import { currentUserHasRole } from "@/lib/server-functions/users";
import { permissionsMiddleware } from "@/middleware/auth";
import { toast } from "sonner";
import { AlertTriangle, Copy, Check } from "lucide-react";
import upperFirst from "lodash/upperFirst";
import Creatable from "react-select/creatable";
import { Logger } from "@hikmahealth/js-utils";

// SERVER FUNCTIONS

const registerDevice = createServerFn({ method: "POST" })
  .validator(
    (data: {
      name: string;
      device_type: Device.DeviceTypeT;
      hardware_id?: string | null;
      hardware_id_type?: Device.HardwareIdTypeT | null;
      os_type?: string | null;
      app_version?: string | null;
      clinic_ids?: string[];
      specifications?: Record<string, any>;
      metadata?: Record<string, any>;
    }) => data,
  )
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "registerDevice",
      });
    }
    return Device.API.register(data);
  });

const updateDevice = createServerFn({ method: "POST" })
  .validator(
    (data: { id: string; input: Device.UpdateDeviceInput }) => data,
  )
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "updateDevice",
      });
    }
    return Device.API.update(data.id, data.input);
  });

const regenerateDeviceApiKey = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "regenerateDeviceApiKey",
      });
    }
    return Device.API.regenerateApiKey(data.id);
  });

const getDeviceById = createServerFn({ method: "GET" })
  .validator((data: { id: string | null }) => data)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "getDeviceById",
      });
    }
    if (!data.id) return null;
    return Device.API.getById(data.id);
  });

// ROUTE

export const Route = createFileRoute("/app/settings/devices/edit/$")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const deviceId = params._splat === "new" ? null : params._splat;
    const isSuperAdmin = await currentUserHasRole({
      data: { role: "super_admin" },
    });
    return {
      device: deviceId ? await getDeviceById({ data: { id: deviceId } }) : null,
      clinics: Result.getOrElse(await getAllClinics(), []),
      isSuperAdmin,
    };
  },
});

// TYPES

type DeviceFormValues = {
  name: string;
  device_type: Device.DeviceTypeT;
  hardware_id: string;
  hardware_id_type: Device.HardwareIdTypeT | "";
  os_type: string;
  app_version: string;
  clinic_ids: string[];
  specifications: string;
};

const DEVICE_TYPE_LABELS: Record<Device.DeviceTypeT, string> = {
  android: "Android",
  ios: "iOS",
  laptop: "Laptop",
  sync_hub: "Sync Hub",
  server: "Server",
  other: "Other",
};

const OS_TYPE_OPTIONS = [
  { value: "Android 16", label: "Android 16" },
  { value: "Android 15", label: "Android 15" },
  { value: "Android 14", label: "Android 14" },
  { value: "Android 13", label: "Android 13" },
  { value: "Android 12", label: "Android 12" },
  { value: "Android 11", label: "Android 11" },
  { value: "Android 10", label: "Android 10" },
  { value: "iOS 26", label: "iOS 26" },
  { value: "iOS 18", label: "iOS 18" },
  { value: "iOS 17", label: "iOS 17" },
  { value: "iOS 16", label: "iOS 16" },
  { value: "iPadOS 26", label: "iPadOS 26" },
  { value: "iPadOS 18", label: "iPadOS 18" },
  { value: "iPadOS 17", label: "iPadOS 17" },
  { value: "Windows 11", label: "Windows 11" },
  { value: "Windows 10", label: "Windows 10" },
  { value: "macOS Tahoe", label: "macOS Tahoe" },
  { value: "macOS Sequoia", label: "macOS Sequoia" },
  { value: "macOS Sonoma", label: "macOS Sonoma" },
  { value: "macOS Ventura", label: "macOS Ventura" },
  { value: "Ubuntu 26.04", label: "Ubuntu 26.04" },
  { value: "Ubuntu 25.10", label: "Ubuntu 25.10" },
  { value: "Ubuntu 25.04", label: "Ubuntu 25.04" },
  { value: "Ubuntu 24.10", label: "Ubuntu 24.10" },
  { value: "Ubuntu 24.04", label: "Ubuntu 24.04" },
  { value: "Ubuntu 22.04", label: "Ubuntu 22.04" },
  { value: "Debian 13", label: "Debian 13" },
  { value: "Debian 12", label: "Debian 12" },
  { value: "ChromeOS", label: "ChromeOS" },
  { value: "Linux", label: "Linux" },
];

const HARDWARE_ID_TYPE_LABELS: Record<Device.HardwareIdTypeT, string> = {
  android_id: "Android ID",
  idfv: "IDFV",
  serial: "Serial",
  mac: "MAC Address",
  custom: "Custom",
};

// API KEY DISPLAY

function ApiKeyDisplay({
  apiKey,
  onDismiss,
}: {
  apiKey: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border-2 border-yellow-400 bg-yellow-50 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-6 w-6 text-yellow-600 mt-0.5 shrink-0" />
        <div className="space-y-1">
          <h3 className="font-semibold text-yellow-800">
            Device API Key Generated
          </h3>
          <p className="text-sm text-yellow-700">
            This API key will only be shown once. Please copy and store it
            securely before continuing.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 block rounded bg-yellow-100 border border-yellow-300 px-4 py-3 font-mono text-sm break-all select-all">
          {apiKey}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="shrink-0"
        >
          {copied ? (
            <Check className="h-4 w-4" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>

      <Button type="button" variant="outline" onClick={onDismiss}>
        I have saved the API key
      </Button>
    </div>
  );
}

// COMPONENT

function RouteComponent() {
  const { device, clinics, isSuperAdmin } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const splatParam = Route.useParams()._splat;
  const isEditMode = Boolean(splatParam && splatParam !== "new" && device);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);

  // `clinic_ids` arrives as string[] or as a JSON string.
  const existingClinicIds: string[] = Array.isArray(device?.clinic_ids)
    ? (device.clinic_ids as string[])
    : [];

  const form = useForm<DeviceFormValues>({
    defaultValues: {
      name: device?.name ?? "",
      device_type: (device?.device_type as Device.DeviceTypeT) ?? "sync_hub",
      hardware_id: device?.hardware_id ?? "",
      hardware_id_type:
        (device?.hardware_id_type as Device.HardwareIdTypeT) ?? "",
      os_type: device?.os_type ?? "",
      app_version: device?.app_version ?? "",
      clinic_ids: existingClinicIds,
      specifications: device?.specifications
        ? JSON.stringify(device.specifications, null, 2)
        : "",
    },
  });

  if (!isSuperAdmin) {
    return (
      <div className="container py-6">
        <p className="text-muted-foreground">
          You are not authorized to view this page. Only Super Admins can manage
          devices.
        </p>
      </div>
    );
  }

  const onSubmit = async (data: DeviceFormValues) => {
    setIsSubmitting(true);
    try {
      let specs: Record<string, any> | undefined;
      if (data.specifications.trim()) {
        try {
          specs = JSON.parse(data.specifications);
        } catch {
          toast.error("Specifications must be valid JSON");
          setIsSubmitting(false);
          return;
        }
      }

      if (isEditMode && device) {
        await updateDevice({
          data: {
            id: device.id,
            input: {
              name: data.name,
              device_type: data.device_type,
              hardware_id: data.hardware_id || null,
              hardware_id_type:
                (data.hardware_id_type as Device.HardwareIdTypeT) || null,
              os_type: data.os_type || null,
              app_version: data.app_version || null,
              clinic_ids: data.clinic_ids,
              specifications: specs,
            },
          },
        });
        toast.success("Device updated successfully");
        navigate({ to: "/app/settings/devices" });
      } else {
        const result = await registerDevice({
          data: {
            name: data.name,
            device_type: data.device_type,
            hardware_id: data.hardware_id || null,
            hardware_id_type:
              (data.hardware_id_type as Device.HardwareIdTypeT) || null,
            os_type: data.os_type || null,
            app_version: data.app_version || null,
            clinic_ids: data.clinic_ids,
            specifications: specs,
          },
        });
        toast.success("Device registered successfully");
        setApiKey(result.api_key);
      }
    } catch (error) {
      Logger.error({ msg: "Error submitting form:", error });
      toast.error("Failed to save device");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegenerateApiKey = async () => {
    if (!device) return;
    if (
      !window.confirm(
        "Are you sure? Regenerating the API key will invalidate the current key. The device will need to be updated with the new key.",
      )
    )
      return;

    setIsRegenerating(true);
    try {
      const result = await regenerateDeviceApiKey({ data: { id: device.id } });
      setApiKey(result.api_key);
      toast.success("API key regenerated");
    } catch (error) {
      Logger.error({ msg: "Failed to regenerate API key:", error });
      toast.error("Failed to regenerate API key");
    } finally {
      setIsRegenerating(false);
    }
  };

  // Post-registration screen. `!isEditMode` keeps a regenerated key from
  // replacing the edit form.
  if (apiKey && !isEditMode) {
    return (
      <div className="container py-6 max-w-xl space-y-6">
        <h1 className="text-2xl font-bold">Device Registered</h1>
        <ApiKeyDisplay
          apiKey={apiKey}
          onDismiss={() => navigate({ to: "/app/settings/devices" })}
        />
      </div>
    );
  }

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">
          {isEditMode ? "Edit Device" : "Register New Device"}
        </h1>
      </div>

      <div className="max-w-xl">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-6"
            autoComplete="off"
          >
            <FormField
              control={form.control}
              name="name"
              rules={{ required: "Name is required" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Clinic A Tablet" {...field} />
                  </FormControl>
                  <FormDescription>
                    A friendly name to identify this device.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="device_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Device Type</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select device type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {Device.deviceTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {DEVICE_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="hardware_id"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hardware ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Optional hardware identifier"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    A unique hardware identifier for this device (optional).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="hardware_id_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hardware ID Type</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value || undefined}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select type (optional)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {Device.hardwareIdTypes.map((type) => (
                        <SelectItem key={type} value={type}>
                          {HARDWARE_ID_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="os_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>OS Type</FormLabel>
                  <Creatable
                    isClearable
                    isSearchable
                    placeholder="Select or type an OS..."
                    options={OS_TYPE_OPTIONS}
                    formatCreateLabel={(input) => `Use "${input}"`}
                    value={
                      field.value
                        ? { value: field.value, label: field.value }
                        : null
                    }
                    onChange={(option) => {
                      field.onChange(option?.value ?? "");
                    }}
                  />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="app_version"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>App Version</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. 2.1.0" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Assigned Clinics */}
            <FormField
              control={form.control}
              name="clinic_ids"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Assigned Clinics</FormLabel>
                  <MultiSelect
                    options={
                      clinics?.map((c) => ({
                        label: c.name || "Unnamed Clinic",
                        value: c.id,
                      })) ?? []
                    }
                    defaultValue={field.value}
                    onValueChange={field.onChange}
                    placeholder="All Clinics (no restriction)"
                  />
                  <FormDescription>
                    Select clinics this device should sync data with. Leave
                    empty for all clinics.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Users dont know how to write json in the first place. this will be auto updated by the end devices */}
            {/*<FormField
              control={form.control}
              name="specifications"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Specifications (JSON)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder='{"ram": "4GB", "storage": "64GB"}'
                      rows={4}
                      className="font-mono text-sm"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Optional device specs as JSON. Leave empty if not needed.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />*/}

            <div className="flex justify-end gap-4">
              <Button type="button" variant="outline" asChild>
                <Link to="/app/settings/devices">Cancel</Link>
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting
                  ? "Saving..."
                  : isEditMode
                    ? "Update Device"
                    : "Register Device"}
              </Button>
            </div>
          </form>
        </Form>

        {/* Regenerate API Key section — edit mode only */}
        {isEditMode && (
          <>
            <hr className="my-8" />

            {apiKey && (
              <div className="mb-6">
                <ApiKeyDisplay
                  apiKey={apiKey}
                  onDismiss={() => setApiKey(null)}
                />
              </div>
            )}

            <div className="space-y-4">
              <h2 className="text-xl font-semibold">Regenerate API Key</h2>
              <p className="text-sm text-muted-foreground">
                Regenerating the API key will immediately invalidate the current
                key. The device will need to be reconfigured with the new key.
              </p>
              <Button
                type="button"
                variant="destructive"
                onClick={handleRegenerateApiKey}
                disabled={isRegenerating}
              >
                {isRegenerating ? "Regenerating..." : "Regenerate API Key"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
