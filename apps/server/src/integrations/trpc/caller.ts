import { TRPCError } from "@trpc/server";
import User from "@/models/user";
import Clinic from "@/models/clinic";
import Device from "@/models/device";
import { Option } from "@/lib/option";
import { Logger } from "@hikmahealth/js-utils";
import type { RequestCaller } from "@/types";
import type { AuthedContext } from "./init";

/**
 * Build a `RequestCaller` suitable for Sync methods from tRPC auth context.
 *
 * The RPC caller is always an authenticated user (via JWT), not a device, so
 * there is no device record to attach — clinic scoping falls back to the user's
 * own clinic.
 */
export async function callerFromContext(
  ctx: AuthedContext,
): Promise<RequestCaller> {
  const user = await User.API.getById(ctx.userId);
  if (!user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "User not found",
    });
  }

  let clinic: Option<Clinic.EncodedT> = Option.none;
  if (user.clinic_id) {
    try {
      const c = await Clinic.getById(user.clinic_id);
      clinic = Option.some(c);
    } catch {
      // Clinic may not exist — proceed without it
    }
  }

  return { user, clinic };
}

/**
 * The peer type a sync request may actually be served as.
 *
 * `peer_type` is caller-supplied, and `sync_hub` widens the entity set in both
 * directions (users, devices, device_pin_codes). Both scoping paths key off
 * `"device" in caller`, so a hub claim from a caller with no device record
 * yields `clinicIds = null` and turns clinic scoping into a no-op — an
 * unchecked claim would read every clinic. Mirrors the rule `/api/v2/sync`
 * already enforces.
 *
 * Written as a capability check rather than an unconditional throw so it stays
 * correct if a device-authenticated caller ever reaches these procedures.
 */
export function resolvePeerType(
  requested: string | undefined,
  caller: RequestCaller,
): Device.DeviceTypeT {
  const peerType = (requested ?? "unknown") as Device.DeviceTypeT;
  if (peerType !== Device.DEVICE_TYPE.SYNC_HUB) return peerType;

  const isHubDevice =
    "device" in caller &&
    caller.device?.device_type === Device.DEVICE_TYPE.SYNC_HUB;

  if (!isHubDevice) {
    // Thrown before the procedures' try blocks, so nothing else records it.
    Logger.warn({
      msg: "[sync] Refused a sync_hub peer_type claim from a non-device caller",
      caller: "user" in caller ? caller.user.id : "device",
    });
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "sync_hub peer type requires device API key authentication",
    });
  }
  return peerType;
}
