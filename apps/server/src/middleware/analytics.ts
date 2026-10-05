import { createMiddleware } from "@tanstack/react-start";
import assert from "assert";

/**
 * Middleware to authenticate the access in using the reporting service
 */
export const authAnalyticsMiddleware = createMiddleware().server(
  async function ({ request, next }) {
    // currently, this is only needed to know what client has accessed what service
    const authToken = request.headers.get("Authorization");
    assert(authToken, "missing `Authorization` from the request header");

    verifyAuthToken(authToken.substring(7));

    // might want to use CORS to check and make sure the known hikma admin is the one that
    // making the api call to the routes guarded by this middleware
    return next();
  },
);

// throws an error if the auth token is invalid
function verifyAuthToken(authToken: string) {
  // check if the JWT token is signed with the registered client secret, and that the digest string in the payload match the md5 of the body
  // NOTE: will implement this later
}
