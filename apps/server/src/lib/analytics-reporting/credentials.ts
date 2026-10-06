import ServerVariable from "@/models/server_variable";
import { z } from "zod";

/**
 * Credentials issued by the reporting service (`HIKMA_REPORTER_URL`) when this
 * instance registers for analytics reporting.
 *
 * They are persisted as a JSON `server_variables` row so they survive restarts.
 */
const credentialsSchema = z.object({
  /** Passed as the `Hikma-Health-Requester` header on requests to the reporter */
  client_id: z.string(),
  /** Used to verify/sign requests between this instance and the reporter */
  client_verifying_key: z.string(),
  version: z.string().or(z.number()).transform(Number),
});

export type ReportingCredentials = z.input<typeof credentialsSchema>;
export type StoredReportingCredentials = z.output<typeof credentialsSchema>;

const KEY = ServerVariable.Keys.HIKMA_REPORTER_CREDENTIALS;

/** Reads saved credentials, or `null` when none exist (or the stored value is invalid). */
export async function readCredentials(): Promise<StoredReportingCredentials | null> {
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
