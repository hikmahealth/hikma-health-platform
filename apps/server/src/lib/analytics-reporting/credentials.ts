import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * Credentials issued by the reporting service (`HIKMA_REPORTER_URL`) when this
 * instance registers for analytics reporting.
 *
 * They are persisted to a JSON file on the instance (under `data/`, which is
 * gitignored) so they survive restarts.
 */
const credentialsSchema = z.object({
  /** Passed as the `Hikma-Health-Requester` header on requests to the reporter */
  client_id: z.string(),
  /** Used to verify/sign requests between this instance and the reporter */
  client_signing_key: z.string(),
  version: z.string().or(z.number()).transform(Number),
});

export type ReportingCredentials = z.input<typeof credentialsSchema>;

const CREDENTIALS_PATH = resolve(
  process.cwd(),
  process.env.ANALYTICS_CREDENTIALS_PATH ?? "data/analytics/credentials.json",
);

/** Reads saved credentials, or `null` when none exist (or the file is unreadable/invalid). */
export async function readCredentials(): Promise<ReportingCredentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, "utf8");
    const parsed = credentialsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    // corrupt JSON or unreadable file: treat as not registered
    return null;
  }
}

export async function saveCredentials(
  credentials: ReportingCredentials,
): Promise<void> {
  const parsed = credentialsSchema.parse(credentials);
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
  // owner read/write only, since this contains a signing key
  await writeFile(CREDENTIALS_PATH, JSON.stringify(parsed, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function deleteCredentials(): Promise<void> {
  await rm(CREDENTIALS_PATH, { force: true });
}
