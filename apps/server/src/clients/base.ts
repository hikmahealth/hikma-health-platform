import { getHersClient } from "@/hers.node";
import { JURL } from "@/hers.node/utils";

if (!process.env.SERVER_URL) {
  throw new Error("missing SERVER_URL from environment variables");
}

export const serverUrl = new JURL(process.env.SERVER_URL);

export const hersclient = getHersClient();
