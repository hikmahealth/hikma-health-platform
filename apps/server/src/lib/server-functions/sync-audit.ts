import { createServerFn } from "@tanstack/react-start";
import { superAdminMiddleware } from "@/middleware/auth";
import { listSyncEvents } from "@/models/sync-audit";
import User from "@/models/user";
import Device from "@/models/device";

export type SyncAuditAccount = { id: string; label: string };

const USER_ID_LENGTH_MAX = 200;

/** One page of sync events. Super admins only. */
export const getSyncEvents = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .validator((data: { page: number; userId?: string }) => {
    if (!Number.isInteger(data.page) || data.page < 1) {
      throw new Error("page must be a positive integer");
    }
    if (data.userId !== undefined && data.userId.length > USER_ID_LENGTH_MAX) {
      throw new Error("userId is too long");
    }
    return data;
  })
  .handler(async ({ data }) => listSyncEvents(data));

/**
 * Every account a sync row can be attributed to, labelled for the filter:
 * users, sync hubs (recorded as `device:<id>`), and failed logins.
 */
export const getSyncAuditAccounts = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async (): Promise<SyncAuditAccount[]> => {
    const [users, devices] = await Promise.all([
      User.API.getAll(),
      Device.API.getAll(),
    ]);

    return [
      ...users.map((user) => ({
        id: user.id,
        label: `${user.name} (${user.email})`,
      })),
      ...devices
        .filter((device) => device.device_type === Device.DEVICE_TYPE.SYNC_HUB)
        .map((device) => ({
          id: `device:${device.id}`,
          label: `Sync hub: ${device.name}`,
        })),
      { id: "unauthenticated", label: "Failed logins (unauthenticated)" },
    ];
  });
