import type { Option } from "./lib/option";
import type Clinic from "./models/clinic";
import type Device from "./models/device";
import type User from "./models/user";

/**
 * The caller that made a request: the user, or the device for trusted peers.
 * Both branches are resolved from the database.
 */
export type RequestCaller =
  | {
      user: User.EncodedT;
      clinic: Option<Clinic.EncodedT>; // There is a slight chance that the user has no clinic
    }
  | {
      // Trusted peers: other servers and local sync hubs.
      device: Device.Table.Devices;
    };
