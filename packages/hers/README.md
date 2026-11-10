# @hikmahealth/hers

Node.js SDK for the HERS API (`/v1`). Requires Node 20+.

- **Client side:** `HersClient` calls the API. It signs short-lived EdDSA JWTs from your client credentials.
- **Server side:** `verifyWebhook` verifies [Standard Webhooks](https://www.standardwebhooks.com/) deliveries from HERS.

It has no runtime dependencies. It uses `node:crypto` (Ed25519 and HMAC-SHA256), `process.env` and the global `fetch`.

## Configuration

Options you don't pass are read from `process.env`:

| Option                 | Environment variable | Notes                                  |
| ---------------------- | -------------------- | -------------------------------------- |
| `baseUrl`              | `HERS_CLIENT_URL`    | Server origin. `/v1` is appended       |
| `credentials.clientId` | `HERS_CLIENT_ID`     | The `client_id`, used as the JWT `iss` |

`credentials.signingKey` (the base64 PKCS#8 DER Ed25519 signing key) must always be passed explicitly.

If a value is missing from both, the constructor throws a `HersError`.

## Provisioning a client

```ts
import { HersClient } from "@hikmahealth/hers";

// baseUrl falls back to HERS_CLIENT_URL
const { client_id, client_signing_key } = await HersClient.createClient({
  name: "clinic-integration",
});
// The signing key (client_signing_key.base64_encoded) is returned once. Store it securely.
```

## Calling the API

```ts
// baseUrl and clientId fall back to HERS_CLIENT_URL and HERS_CLIENT_ID
const hers = new HersClient({ credentials: { signingKey } });

// or explicitly
const hers = new HersClient({
  baseUrl: "https://hers.example.com",
  credentials: { clientId, signingKey },
});

await hers.status();

await hers.registerWebhook({
  events: ["environment.anomaly_detected"],
  webhookUrl: "https://my-app.example.com/hers/webhook",
}); // -> { id, events, secret } (the secret is returned once)

await hers.ems.subscribe({
  features: ["pm_2_5", "temperature"],
  duration: "7d",
  metadata: { forecast_days: 5 },
  locations: [{ key: "clinic-1", latitude: -6.8, longitude: 39.2 }],
});
await hers.ems.listSubscriptions({ location: "clinic-1" });
await hers.ems.unsubscribe({ location_references: ["clinic-1"] });

const results = await hers.hers.classify("clinic-1", [
  { id: "patient-1", sex: "female", age_in_days: 25000 },
  { id: "patient-2" },
]);
```

Tokens are cached and re-signed 30 seconds before they expire. The server allows a lifetime of at most 300 seconds.
You can change this with `tokenOptions`.

### Errors

Non-2xx responses throw a subclass of `HersApiError` (`status`, `body`):

| Status | Error                                                                 |
| ------ | --------------------------------------------------------------------- |
| 400    | `HersValidationError` (`.error` holds the server's validation detail) |
| 401    | `HersAuthenticationError`                                             |
| 403    | `HersForbiddenError`                                                  |
| 404    | `HersNotFoundError`                                                   |
| other  | `HersApiError`                                                        |

## Verifying webhooks

`verifyWebhook` is synchronous. It needs the **raw** request body as a `Buffer` or string. Do not re-serialize
parsed JSON.

```ts
import express from "express";
import {
  verifyWebhook,
  WebhookVerificationError,
} from "@hikmahealth/hers/webhooks";

app.post(
  "/hers/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    try {
      const { id, event } = verifyWebhook({
        secret: webhookSecret, // whsec_...
        headers: req.headers,
        body: req.body, // raw Buffer
      });
      // Deduplicate on `id`: it stays the same across retries.
      if (event.type === "environment.anomaly_detected") {
        // event.data.anomalies ...
      }
      res.sendStatus(204);
    } catch (err) {
      if (err instanceof WebhookVerificationError)
        return res.status(400).send(err.message);
      throw err;
    }
  },
);
```

`headers` accepts Node's `IncomingHttpHeaders` (`req.headers`) or a Fetch `Headers` object. Timestamps more than
5 minutes from now are rejected by default. You can change this with `toleranceSeconds`.
`signWebhookPayload` builds signatures for testing your handlers.
