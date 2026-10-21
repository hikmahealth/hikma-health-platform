import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Kysely } from "kysely";
import { Logger } from "@hikmahealth/js-utils";
import type { DB } from "@hikmahealth/database/types/schema/hh";

/** Shown in the DigitalOcean deploy form; it is public, so it is never a token. */
export const SETUP_TOKEN_PLACEHOLDER = "paste-a-long-passphrase-or-leave-blank";
export const SETUP_TOKEN_LENGTH_MIN = 24;

const GENERATED_TOKEN_BYTES = 20;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** How the operator configured `SETUP_TOKEN`. */
export type ConfiguredSetupToken =
  | { kind: "unset" }
  | { kind: "configured"; token: string }
  | { kind: "invalid"; reason: string };

/** Where the token for a pending setup comes from, if setup is pending at all. */
export type SetupTokenState =
  | { kind: "complete" }
  | { kind: "from-env" }
  | { kind: "generated"; token: string }
  | { kind: "misconfigured"; reason: string };

/** Reads `process.env`: `import.meta.env` lacks unprefixed variables on the server. */
export const resolveSetupToken = (
  raw: string | undefined = process.env.SETUP_TOKEN,
): ConfiguredSetupToken => {
  const value = raw?.trim() ?? "";
  if (value === "") return { kind: "unset" };
  if (value === SETUP_TOKEN_PLACEHOLDER) return { kind: "unset" };
  if (value.length < SETUP_TOKEN_LENGTH_MIN) {
    return {
      kind: "invalid",
      reason: `SETUP_TOKEN must be at least ${SETUP_TOKEN_LENGTH_MIN} characters`,
    };
  }
  return { kind: "configured", token: value };
};

const base32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
};

/** A random token, grouped in fours so it can be read off a log and typed. */
export const generateSetupToken = (): string =>
  base32(randomBytes(GENERATED_TOKEN_BYTES))
    .match(/.{1,4}/g)!
    .join("-");

const digest = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison; `null` expected means nothing can match. */
export const setupTokenMatches = (
  candidate: string,
  expected: string | null,
): boolean => {
  if (expected === null) return false;
  return timingSafeEqual(digest(candidate.trim()), digest(expected));
};

/** Generated tokens are retyped from logs, so case, dashes and spaces are forgiven. */
const normaliseGeneratedToken = (value: string): string =>
  value.toUpperCase().replace(/[\s-]/g, "");

/** An env token must match exactly and replaces any generated token printed earlier. */
export const setupTokenAccepts = (
  candidate: string,
  storedToken: string | null,
  configured: ConfiguredSetupToken = resolveSetupToken(),
): boolean => {
  switch (configured.kind) {
    case "configured":
      return setupTokenMatches(candidate, configured.token);
    case "invalid":
      return false;
    case "unset":
      return storedToken === null
        ? false
        : setupTokenMatches(
            normaliseGeneratedToken(candidate),
            normaliseGeneratedToken(storedToken),
          );
  }
};

/** Generates and stores a token if none is configured; concurrent instances agree on one. */
export const getOrCreateSetupToken = async (
  db: Kysely<DB>,
  configured: ConfiguredSetupToken = resolveSetupToken(),
): Promise<SetupTokenState> => {
  const row = await db
    .selectFrom("instance_setup")
    .select(["token", "completed_at"])
    .where("id", "=", 1)
    .executeTakeFirst();

  if (!row) return { kind: "complete" };
  if (row.completed_at !== null) return { kind: "complete" };
  if (configured.kind === "configured") return { kind: "from-env" };
  if (configured.kind === "invalid") {
    return { kind: "misconfigured", reason: configured.reason };
  }
  if (row.token !== null) return { kind: "generated", token: row.token };

  await db
    .updateTable("instance_setup")
    .set({ token: generateSetupToken() })
    .where("id", "=", 1)
    .where("token", "is", null)
    .where("completed_at", "is", null)
    .execute();

  const stored = await db
    .selectFrom("instance_setup")
    .select(["token", "completed_at"])
    .where("id", "=", 1)
    .executeTakeFirst();

  if (!stored) return { kind: "complete" };
  if (stored.completed_at !== null) return { kind: "complete" };
  if (stored.token === null) {
    throw new Error(
      "instance_setup token is missing right after it was written",
    );
  }
  return { kind: "generated", token: stored.token };
};

/** Discards a generated token so a new one is made. Returns whether one was cleared. */
export const resetSetupToken = async (db: Kysely<DB>): Promise<boolean> => {
  const result = await db
    .updateTable("instance_setup")
    .set({ token: null })
    .where("id", "=", 1)
    .where("completed_at", "is", null)
    .where("token", "is not", null)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
};

const serverUrl = (): string =>
  process.env.SERVER_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "https://<your-server>";

/** The boot-log text for a token state; `null` when there is nothing to say. */
export const formatSetupAnnouncement = (
  state: SetupTokenState,
  configured: ConfiguredSetupToken = resolveSetupToken(),
  url: string = serverUrl(),
): string | null => {
  const setupUrl = `${url.replace(/\/+$/, "")}/setup`;
  switch (state.kind) {
    case "complete":
      return configured.kind === "unset"
        ? null
        : "Setup is complete. SETUP_TOKEN is no longer used.";
    case "from-env":
      return `Setup is waiting at ${setupUrl} — use the SETUP_TOKEN you configured.`;
    case "misconfigured":
      return `Setup cannot start: ${state.reason}.`;
    case "generated": {
      const lines = [
        "Hikma Health is ready to be set up.",
        `Open:  ${setupUrl}`,
        `Token: ${state.token}`,
      ];
      const width = Math.max(...lines.map((line) => line.length));
      const rule = `+${"-".repeat(width + 2)}+`;
      return [
        rule,
        ...lines.map((line) => `| ${line.padEnd(width)} |`),
        rule,
      ].join("\n");
    }
  }
};

let announced = false;

/** Prints the setup announcement once per process. Never throws. */
export const announceSetupToken = async (
  db: Kysely<DB>,
): Promise<SetupTokenState> => {
  const configured = resolveSetupToken();
  let state: SetupTokenState;
  try {
    state = await getOrCreateSetupToken(db, configured);
  } catch (error) {
    Logger.Production.error({ msg: "Could not read setup state", error });
    return { kind: "complete" };
  }
  if (announced) return state;
  announced = true;

  const message = formatSetupAnnouncement(state, configured);
  if (message === null) return state;
  if (state.kind === "misconfigured") {
    Logger.Production.error(message);
  } else {
    Logger.Production.log(message);
  }
  return state;
};
