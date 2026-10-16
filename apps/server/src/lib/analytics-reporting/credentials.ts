import ServerVariable from "@/models/server_variable";
import { z } from "zod";

/** Credentials issued at registration, stored as a JSON `server_variables` row. */
const credentialsSchema = z.object({
  /** `sub` of tokens sent to the backoffice */
  client_id: z.string().min(1),
  /** Ed25519 PKCS#8 DER, base64url; only ever returned at registration */
  client_signing_key: z.string().min(1),
  /** Ed25519 SPKI DER, base64url; verifies backoffice pulls */
  client_verifying_key: z.string().min(1),
  /** `sub` of backoffice pulls */
  reporter_id: z.string().min(1),
  version: z.number().int(),
});

export type ReportingCredentials = z.infer<typeof credentialsSchema>;

const KEY = ServerVariable.Keys.HIKMA_REPORTER_CREDENTIALS;

/** Reads saved credentials, or `null` when none exist (or the stored value is invalid). */
export async function readCredentials(): Promise<ReportingCredentials | null> {
  try {
    const value = await ServerVariable.getAsJson(KEY);
    if (value == null) return null;
    const parsed = credentialsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch (err) {
    console.error("Failed when readCredentials:", err);
    // wrong value type or corrupt JSON: treat as not registered
    return null;
  }
}

export async function saveCredentials(
  credentials: ReportingCredentials,
): Promise<void> {
  const parsed = credentialsSchema.parse(credentials);
  await ServerVariable.setJson(
    KEY,
    parsed,
    "Credentials issued by the Hikma Health analytics reporting service",
  );
}

/** Revokes the stored credentials (clears the value, keeping the row). */
export async function deleteCredentials(): Promise<void> {
  await ServerVariable.clearValue(KEY);
}
