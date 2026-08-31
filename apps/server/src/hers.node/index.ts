import assert from "node:assert";
import { JURL } from "./utils";

class Client {
  readonly baseurl;
  constructor(url: string, clientId: string, clientSecret: string) {
    this.baseurl = new JURL(url);
  }

  createHeader() {
    const header = new Headers();
    header.set("Authorization", `Basic ${"clientId:clientSecret"}`);
    return header;
  }
}

/**
 * Get the HERS client running
 */
export const getHersClient = function () {
  const url = process.env.HERS_SERVICE_BASE_URL;
  const clientId = process.env.HERS_SERVICE_CLIENT_ID;
  const clientSecret = process.env.HERS_SERVICE_CLIENT_SECRET;

  assert(url, `HERS_SERVICE_BASE_URL missing from environment variables`);
  assert(clientId, `HERS_SERVICE_CLIENT_ID missing from environment variables`);
  assert(
    clientSecret,
    `HERS_SERVICE_CLIENT_SECRET missing from environment variables`,
  );

  // fetch values from URL
  return new Client(url, clientId, clientSecret);
};
