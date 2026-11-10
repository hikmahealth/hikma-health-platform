/** Environment variable holding the HERS server URL. */
export const HERS_CLIENT_URL = "HERS_CLIENT_URL";
/** Environment variable holding the client id (the JWT `iss`). */
export const HERS_CLIENT_ID = "HERS_CLIENT_ID";

/** Reads a non-empty environment variable from `process.env`. */
export function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
