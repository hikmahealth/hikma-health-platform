import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SelectInput } from "@/components/select-input";
import { StorageSettingsSection } from "@/components/settings/storage-settings-section";
import { getStorageSettings } from "@/lib/server-functions/storage-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getCurrentUser } from "@/lib/server-functions/auth";
import { permissionsMiddleware, superAdminMiddleware } from "@/middleware/auth";
import AppConfig from "@/models/app-config";
import ServerVariable from "@/models/server_variable";
import User from "@/models/user";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { useImmerReducer } from "use-immer";

const saveConfiguration = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      // TODO: set this to the type of a namespace from the AppConfig module
      namespace: string;
      key: string;
      displayName: string | null;
      value: string | null | boolean | number;
      dataType: AppConfig.DataTypeT;
      updatedBy: string;
    }) => data,
  )
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (!context.userId || context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Isufficient permissions",
        source: "saveConfiguration",
      });
    }
    const { namespace, key, displayName, value, dataType, updatedBy } = data;
    return await AppConfig.API.set(
      namespace,
      key,
      displayName,
      value,
      dataType,
      updatedBy,
    );
  });

const getAllConfigurations = createServerFn({ method: "GET" })
  .middleware([permissionsMiddleware])
  .handler(async ({ context }) => {
    if (!context.userId || context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Isufficient permissions",
        source: "getAllConfigurations",
      });
    }
    return await AppConfig.API.getAll();
  });

const getServerVariable = createServerFn({ method: "GET" })
  .inputValidator((data: { key: string }) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return await ServerVariable.get(data.key);
  });

const upsertServerVariable = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      key: string;
      value_type: string;
      description?: string | null;
      value_data?: Uint8Array | null;
      value_hash?: string | null;
    }) => data,
  )
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    return await ServerVariable.update(data);
  });

export const Route = createFileRoute("/app/settings/configurations/")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const [
      config,
      anthropicKeyVar,
      openaiKeyVar,
      geminiKeyVar,
      aiUrlVariable,
      aiProxyKeyVar,
      storage,
    ] = await Promise.all([
      getAllConfigurations(),
      getServerVariable({
        data: { key: ServerVariable.Keys.ANTHROPIC_API_KEY },
      }),
      getServerVariable({
        data: { key: ServerVariable.Keys.OPENAI_API_KEY },
      }),
      getServerVariable({
        data: { key: ServerVariable.Keys.GEMINI_API_KEY },
      }),
      getServerVariable({
        data: { key: ServerVariable.Keys.AI_DATA_ANALYSIS_URL },
      }),
      getServerVariable({
        data: { key: ServerVariable.Keys.AI_PROXY_SERVICE_API_KEY },
      }),
      getStorageSettings(),
    ]);
    const toBytes = (data: unknown): Uint8Array | null => {
      if (data == null) return null;
      if (data instanceof Uint8Array) return data;
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      // Serialized Uint8Array comes back as a plain object like { 0: 72, 1: 101, ... }
      if (typeof data === "object")
        return new Uint8Array(Object.values(data as Record<string, number>));
      return null;
    };

    const aiServiceUrl = aiUrlVariable?.value_data
      ? new TextDecoder().decode(
          toBytes(aiUrlVariable.value_data) ?? new Uint8Array(),
        )
      : "";
    const hasValue = (v: { value_data: unknown } | null | undefined) => {
      if (v?.value_data == null) return false;
      const bytes = toBytes(v.value_data);
      return bytes != null && bytes.length > 0;
    };

    return {
      config,
      anthropicKeyIsSet: hasValue(anthropicKeyVar),
      openaiKeyIsSet: hasValue(openaiKeyVar),
      geminiKeyIsSet: hasValue(geminiKeyVar),
      aiProxyKeyIsSet: hasValue(aiProxyKeyVar),
      aiServiceUrl,
      storage,
      currentUser: await getCurrentUser(),
    };
  },
});

const overrideMobilePermissionsConfirmation =
  "I am sure I want to disable permissions on mobile devices";

function RouteComponent() {
  const {
    config,
    anthropicKeyIsSet,
    openaiKeyIsSet,
    geminiKeyIsSet,
    aiProxyKeyIsSet,
    aiServiceUrl,
    storage,
    currentUser,
  } = Route.useLoaderData();
  const router = useRouter();
  const [openDialog, setOpenDialog] = useState<{
    title: string;
    description: string;
    onConfirm: <T1 extends string>(arg1: T1) => void;
    confirmationText?: string;
    userInputText?: string;
  } | null>(null);

  const [organizationName, setOrganizationName] = useState(
    AppConfig.Utils.getValue<string>(
      config,
      AppConfig.Namespaces.ORGANIZATION,
      "organization-name",
    ) || "",
  );

  const isMobilePermissionsOverridden =
    AppConfig.Utils.getValue<boolean>(
      config,
      AppConfig.Namespaces.AUTH,
      "disable-mobile-permissions-checking",
    ) || false;

  const operationMode =
    AppConfig.Utils.getValue<string>(
      config,
      AppConfig.Namespaces.SYSTEM,
      "operation_mode",
    ) || "user_choice";

  const isScreenCaptureAllowed =
    AppConfig.Utils.getValue<boolean>(
      config,
      AppConfig.Namespaces.SYSTEM,
      "allow-mobile-screen-capture",
    ) || false;

  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [aiProxyApiKey, setAiProxyApiKey] = useState("");
  const [aiUrl, setAiUrl] = useState(aiServiceUrl);

  const handleSaveAiSettings = () => {
    if (!currentUser) return;
    const encoder = new TextEncoder();
    const promises: Promise<unknown>[] = [];

    if (anthropicApiKey) {
      promises.push(
        upsertServerVariable({
          data: {
            key: ServerVariable.Keys.ANTHROPIC_API_KEY,
            value_type: "secret",
            description: "Anthropic API key",
            value_data: encoder.encode(anthropicApiKey),
          },
        }),
      );
    }

    if (openaiApiKey) {
      promises.push(
        upsertServerVariable({
          data: {
            key: ServerVariable.Keys.OPENAI_API_KEY,
            value_type: "secret",
            description: "OpenAI API key",
            value_data: encoder.encode(openaiApiKey),
          },
        }),
      );
    }

    if (geminiApiKey) {
      promises.push(
        upsertServerVariable({
          data: {
            key: ServerVariable.Keys.GEMINI_API_KEY,
            value_type: "secret",
            description: "Google Gemini API key",
            value_data: encoder.encode(geminiApiKey),
          },
        }),
      );
    }

    if (aiProxyApiKey) {
      promises.push(
        upsertServerVariable({
          data: {
            key: ServerVariable.Keys.AI_PROXY_SERVICE_API_KEY,
            value_type: "secret",
            description: "AI proxy service API key",
            value_data: encoder.encode(aiProxyApiKey),
          },
        }),
      );
    }

    if (aiUrl !== aiServiceUrl) {
      promises.push(
        upsertServerVariable({
          data: {
            key: ServerVariable.Keys.AI_DATA_ANALYSIS_URL,
            value_type: "url",
            description: "URL for AI data analysis and reporting service",
            value_data: encoder.encode(aiUrl),
          },
        }),
      );
    }

    if (promises.length === 0) return;

    Promise.all(promises)
      .then(() => {
        toast.success("AI settings saved successfully");
        setAnthropicApiKey("");
        setOpenaiApiKey("");
        setGeminiApiKey("");
        setAiProxyApiKey("");
      })
      .catch((error) => {
        toast.error(`Failed to save AI settings: ${error.message}`);
      })
      .finally(() => {
        router.invalidate({ sync: true });
      });
  };

  const handleOperationModeChange = (value: string | null) => {
    if (!currentUser || !value) return;

    saveConfiguration({
      data: {
        namespace: AppConfig.Namespaces.SYSTEM,
        key: "operation_mode",
        displayName: "Mobile App Operation Mode",
        value,
        dataType: "string",
        updatedBy: currentUser.id,
      },
    })
      .then(() => {
        toast.success("Operation mode updated successfully");
      })
      .catch((error) => {
        toast.error(`Failed to update operation mode: ${error.message}`);
      })
      .finally(() => {
        router.invalidate({ sync: true });
      });
  };

  const handleToggleScreenCapture = (checked: boolean) => {
    if (!currentUser) return;

    saveConfiguration({
      data: {
        namespace: AppConfig.Namespaces.SYSTEM,
        key: "allow-mobile-screen-capture",
        displayName: "Allow Mobile Screenshots & Screen Recording",
        value: checked,
        dataType: "boolean",
        updatedBy: currentUser.id,
      },
    })
      .then(() => {
        toast.success(
          checked
            ? "Screenshots and screen recording allowed on mobile"
            : "Screenshots and screen recording blocked on mobile",
        );
      })
      .catch((error) => {
        toast.error(
          `Failed to update screen capture setting: ${error.message}`,
        );
      })
      .finally(() => {
        router.invalidate({ sync: true });
      });
  };

  const handleSaveOrganizationName = () => {
    // TODO: send to sign in page if there is no user
    if (!currentUser) return;

    saveConfiguration({
      data: {
        namespace: AppConfig.Namespaces.ORGANIZATION,
        key: "organization-name",
        displayName: "Organization Name",
        value: organizationName,
        dataType: "string",
        updatedBy: currentUser.id,
      },
    })
      .then(() => {
        toast.success("Organization name saved successfully");
      })
      .catch((error) => {
        toast.error(`Failed to save organization name: ${error.message}`);
      })
      .finally(() => {
        router.invalidate({ sync: true });
      });
  };

  const handleToggleOverrideMobilePermissions = (checked: boolean) => {
    // If it is currently enabled, just disable without confirmation
    if (!currentUser) return;
    if (checked === false) {
      return saveConfiguration({
        data: {
          namespace: AppConfig.Namespaces.AUTH,
          key: "disable-mobile-permissions-checking",
          displayName: "Override Mobile Permissions",
          value: checked,
          dataType: "boolean",
          updatedBy: currentUser.id,
        },
      })
        .then(() => {
          toast.success("Override mobile permissions disabled successfully");
        })
        .catch((error) => {
          toast.error(
            `Failed to disable override mobile permissions: ${error.message}`,
          );
        })
        .finally(() => {
          router.invalidate({ sync: true });
        });
    }

    // Confirm before toggling, ask user if they are sure and ask them to type "confirm"
    setOpenDialog({
      title: "Toggle Override Mobile Permissions",
      description: `
      Are you sure you want to toggle override mobile permissions?

      Type "${overrideMobilePermissionsConfirmation}" to confirm`,
      confirmationText: overrideMobilePermissionsConfirmation,
      userInputText: "",
      onConfirm: (userInputText: string) => {
        if (userInputText === overrideMobilePermissionsConfirmation) {
          saveConfiguration({
            data: {
              namespace: AppConfig.Namespaces.AUTH,
              key: "disable-mobile-permissions-checking",
              displayName: "Override Mobile Permissions",
              value: checked,
              dataType: "boolean",
              updatedBy: currentUser.id,
            },
          })
            .then(() => {
              toast.success("Override mobile permissions toggled successfully");
              setOpenDialog(null);
            })
            .catch((error) => {
              toast.error(
                `Failed to toggle override mobile permissions: ${error.message}`,
              );
            })
            .finally(() => {
              router.invalidate({ sync: true });
            });
        } else {
          toast.error("Invalid confirmation text", { richColors: true });
        }
      },
    });
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Configurations</h1>
          <div className="text-sm text-muted-foreground">
            Settings and configuration flags that can be set for the entire
            Hikma Health Application.
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-10">
        <div className="flex flex-row gap-4 items-end">
          <Input
            label="Organization Name"
            description="The name of your organization"
            defaultValue={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            className="lg:w-md"
          />
          <Button onClick={handleSaveOrganizationName}>Save</Button>
        </div>

        <div className="flex flex-row gap-14 items-end">
          <Checkbox
            label="Override Mobile Permissions"
            description="Override the mobile permissions for all users"
            color="destructive"
            checked={isMobilePermissionsOverridden}
            onCheckedChange={handleToggleOverrideMobilePermissions}
          />
        </div>

        <div className="flex flex-col gap-4 pt-4 border-t">
          <h2 className="text-lg font-semibold">Mobile Configurations</h2>

          <SelectInput
            label="Operation Mode"
            description="Controls whether the mobile app operates in online, offline, or lets the user choose"
            value={operationMode}
            onChange={handleOperationModeChange}
            allowDeselect={false}
            className="lg:w-md"
            data={[
              { value: "online", label: "Online" },
              { value: "offline", label: "Offline" },
              { value: "user_choice", label: "User Choice" },
            ]}
          />

          <Checkbox
            label="Allow Screenshots & Screen Recording"
            description="Off by default. When on, clinicians can screenshot, record, and cast patient records from the mobile app. Devices apply the change on their next sync."
            color="destructive"
            checked={isScreenCaptureAllowed}
            onCheckedChange={handleToggleScreenCapture}
          />
        </div>

        <div className="flex flex-col gap-4 pt-4 border-t">
          <h2 className="text-lg font-semibold">Client App Layout</h2>
          <div className="text-sm text-muted-foreground">
            Control what clinicians see, and in what order, inside the mobile
            app. Changes reach devices on their next sync.
          </div>

          <div>
            <Button asChild variant="outline">
              <Link to="/app/settings/configurations/patient-view-actions">
                Patient view actions
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>

        <StorageSettingsSection
          settings={storage}
          onSaved={() => router.invalidate({ sync: true })}
        />

        <div className="flex flex-col gap-4 pt-4 border-t">
          <h2 className="text-lg font-semibold">AI</h2>

          <div className="flex flex-row gap-4 items-end">
            <Input
              label="Service URL"
              description="The URL or IP address of the AI data analysis service"
              placeholder="https://ai-service.example.com"
              value={aiUrl}
              onChange={(e) => setAiUrl(e.target.value)}
              autoComplete="one-time-code"
              className="lg:w-md"
            />
            <Input
              label="AI Proxy Service API Key"
              description={
                aiProxyKeyIsSet
                  ? "A key is currently set. Enter a new value to replace it."
                  : "Enter the API key for the AI proxy service."
              }
              type="password"
              placeholder={aiProxyKeyIsSet ? "••••••••" : "Enter API key"}
              value={aiProxyApiKey}
              onChange={(e) => setAiProxyApiKey(e.target.value)}
              autoComplete="new-password"
              className="lg:w-md"
            />
          </div>

          <div className="flex flex-row gap-4 items-end">
            <Input
              label="Anthropic API Key"
              description={
                anthropicKeyIsSet
                  ? "A key is currently set. Enter a new value to replace it."
                  : "Enter your Anthropic API key."
              }
              type="password"
              placeholder={anthropicKeyIsSet ? "••••••••" : "Enter API key"}
              value={anthropicApiKey}
              onChange={(e) => setAnthropicApiKey(e.target.value)}
              autoComplete="new-password"
              className="lg:w-md"
            />
          </div>

          <div className="flex flex-row gap-4 items-end">
            <Input
              label="OpenAI API Key"
              description={
                openaiKeyIsSet
                  ? "A key is currently set. Enter a new value to replace it."
                  : "Enter your OpenAI API key."
              }
              type="password"
              placeholder={openaiKeyIsSet ? "••••••••" : "Enter API key"}
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              autoComplete="new-password"
              className="lg:w-md"
            />
          </div>

          <div className="flex flex-row gap-4 items-end">
            <Input
              label="Gemini API Key"
              description={
                geminiKeyIsSet
                  ? "A key is currently set. Enter a new value to replace it."
                  : "Enter your Google Gemini API key."
              }
              type="password"
              placeholder={geminiKeyIsSet ? "••••••••" : "Enter API key"}
              value={geminiApiKey}
              onChange={(e) => setGeminiApiKey(e.target.value)}
              autoComplete="new-password"
              className="lg:w-md"
            />
          </div>

          <div>
            <Button
              onClick={handleSaveAiSettings}
              disabled={
                !anthropicApiKey &&
                !openaiApiKey &&
                !geminiApiKey &&
                !aiProxyApiKey &&
                aiUrl === aiServiceUrl
              }
            >
              Save
            </Button>
          </div>
        </div>
      </div>
      <Dialog
        open={openDialog !== null}
        onOpenChange={() => setOpenDialog(null)}
      >
        {openDialog !== null && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{openDialog.title}</DialogTitle>
            </DialogHeader>

            <DialogDescription>
              {openDialog.description}
              <br />
              <br />
              <Input
                value={openDialog.userInputText}
                onChange={({ target }) =>
                  setOpenDialog({ ...openDialog, userInputText: target.value })
                }
              />
            </DialogDescription>

            <DialogFooter>
              <Button onClick={() => setOpenDialog(null)}>Cancel</Button>
              <Button
                onClick={() =>
                  openDialog.onConfirm(openDialog.userInputText || "")
                }
              >
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
