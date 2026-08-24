import { createFileRoute, useRouter } from "@tanstack/react-router";
import Device from "@/models/device";
import { createServerFn } from "@tanstack/react-start";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { permissionsMiddleware } from "@/middleware/auth";
import { currentUserHasRole } from "@/lib/server-functions/users";
import User from "@/models/user";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Logger } from "@hikmahealth/js-utils";
import { ConnectMobileAppCard } from "@/components/connect-mobile-app-card";

// SERVER FUNCTIONS

const getAllDevices = createServerFn({ method: "GET" })
  .middleware([permissionsMiddleware])
  .handler(async ({ context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return [];
    }
    return Device.API.getAll();
  });

const deleteDevice = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "deleteDevice",
      });
    }
    return Device.API.softDelete(data.id);
  });

const updateDeviceStatus = createServerFn({ method: "POST" })
  .validator((d: { id: string; status: Device.StatusT }) => d)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "updateDeviceStatus",
      });
    }
    return Device.API.updateStatus(data.id, data.status);
  });

const resetPinAttempts = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .middleware([permissionsMiddleware])
  .handler(async ({ data, context }) => {
    if (context.role !== User.ROLES.SUPER_ADMIN) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "resetPinAttempts",
      });
    }
    return Device.API.resetFailedPinAttempts(data.id);
  });

// ROUTE

export const Route = createFileRoute("/app/settings/devices/")({
  component: RouteComponent,
  loader: async () => {
    const isSuperAdmin = await currentUserHasRole({
      data: { role: "super_admin" },
    });
    return {
      devices: isSuperAdmin ? await getAllDevices() : [],
      isSuperAdmin,
    };
  },
});

// HELPERS

const STATUS_BADGE_VARIANT: Record<
  Device.StatusT,
  "default" | "secondary" | "outline" | "destructive"
> = {
  active: "default",
  inactive: "secondary",
  suspended: "outline",
  decommissioned: "destructive",
};

const STATUS_BADGE_CLASS: Record<Device.StatusT, string> = {
  active: "bg-green-600 hover:bg-green-700",
  inactive: "bg-gray-500 hover:bg-gray-600",
  suspended: "bg-yellow-500 hover:bg-yellow-600 text-black",
  decommissioned: "bg-red-600 hover:bg-red-700",
};

const DEVICE_TYPE_LABELS: Record<Device.DeviceTypeT, string> = {
  android: "Android",
  ios: "iOS",
  laptop: "Laptop",
  sync_hub: "Sync Hub",
  server: "Server",
  other: "Other",
};

function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

// COMPONENT

function RouteComponent() {
  const { devices, isSuperAdmin } = Route.useLoaderData();
  const router = useRouter();
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // The QR sits above the gate on purpose: scanning it writes a peer URL on
  // the phone and grants nothing server-side, and it used to be ungated.
  if (!isSuperAdmin) {
    return (
      <div className="container py-6">
        <h1 className="text-2xl font-bold mb-6">Devices</h1>
        <ConnectMobileAppCard />
        <p className="text-muted-foreground">
          Only Super Admins can view and manage registered devices.
        </p>
      </div>
    );
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm("Are you sure you want to delete this device?")) return;
    setLoadingId(id);
    try {
      await deleteDevice({ data: { id } });
      router.invalidate({ sync: true });
      toast.success("Device deleted");
    } catch (e) {
      Logger.error({ msg: "Failed to delete device:", e });
      toast.error("Failed to delete device");
    } finally {
      setLoadingId(null);
    }
  };

  const handleStatusChange = async (id: string, status: Device.StatusT) => {
    setLoadingId(id);
    try {
      await updateDeviceStatus({ data: { id, status } });
      router.invalidate({ sync: true });
      toast.success(`Device status changed to ${status}`);
    } catch (e) {
      Logger.error({ msg: "Failed to update device status:", e });
      toast.error("Failed to update device status");
    } finally {
      setLoadingId(null);
    }
  };

  const handleResetPinAttempts = async (id: string) => {
    setLoadingId(id);
    try {
      await resetPinAttempts({ data: { id } });
      router.invalidate({ sync: true });
      toast.success("PIN attempts reset");
    } catch (e) {
      Logger.error({ msg: "Failed to reset PIN attempts:", e });
      toast.error("Failed to reset PIN attempts");
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Devices</h1>
        <Button asChild>
          <Link to="/app/settings/devices/edit/$" params={{ _splat: "new" }}>
            Register New Device
          </Link>
        </Button>
      </div>

      <ConnectMobileAppCard />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Device Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Seen</TableHead>
              <TableHead>Created At</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {devices.map((device) => {
              const status = device.status as Device.StatusT;
              const deviceType = device.device_type as Device.DeviceTypeT;
              return (
                <TableRow key={device.id}>
                  <TableCell className="font-medium">{device.name}</TableCell>
                  <TableCell>
                    {DEVICE_TYPE_LABELS[deviceType] ?? deviceType}
                  </TableCell>
                  <TableCell>
                    <Badge className={STATUS_BADGE_CLASS[status] ?? ""}>
                      {status}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatDate(device.last_seen_at)}</TableCell>
                  <TableCell>{formatDate(device.created_at)}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={loadingId === device.id}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link
                            to="/app/settings/devices/edit/$"
                            params={{ _splat: device.id }}
                          >
                            Edit
                          </Link>
                        </DropdownMenuItem>

                        <DropdownMenuSeparator />

                        {status !== Device.STATUS.ACTIVE && (
                          <DropdownMenuItem
                            onClick={() =>
                              handleStatusChange(
                                device.id,
                                Device.STATUS.ACTIVE,
                              )
                            }
                          >
                            Activate
                          </DropdownMenuItem>
                        )}
                        {status !== Device.STATUS.INACTIVE && (
                          <DropdownMenuItem
                            onClick={() =>
                              handleStatusChange(
                                device.id,
                                Device.STATUS.INACTIVE,
                              )
                            }
                          >
                            Deactivate
                          </DropdownMenuItem>
                        )}
                        {status !== Device.STATUS.SUSPENDED && (
                          <DropdownMenuItem
                            onClick={() =>
                              handleStatusChange(
                                device.id,
                                Device.STATUS.SUSPENDED,
                              )
                            }
                          >
                            Suspend
                          </DropdownMenuItem>
                        )}
                        {status !== Device.STATUS.DECOMMISSIONED && (
                          <DropdownMenuItem
                            onClick={() =>
                              handleStatusChange(
                                device.id,
                                Device.STATUS.DECOMMISSIONED,
                              )
                            }
                          >
                            Decommission
                          </DropdownMenuItem>
                        )}

                        {device.failed_pin_attempts > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleResetPinAttempts(device.id)}
                            >
                              Reset PIN Attempts ({device.failed_pin_attempts})
                            </DropdownMenuItem>
                          </>
                        )}

                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleDelete(device.id)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
            {devices.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-4">
                  No devices found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
