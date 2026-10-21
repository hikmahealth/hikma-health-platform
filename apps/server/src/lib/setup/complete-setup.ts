import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { type Kysely, type Transaction, sql } from "kysely";
import { v1 as uuidV1 } from "uuid";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import UserClinicPermissions from "@/models/user-clinic-permissions";
import { checkPassword } from "./common-passwords";
import { SEED_ADMIN_EMAIL } from "./default-credential";
import { normaliseEmail, normaliseName } from "@/lib/user-identity";
import {
  type ConfiguredSetupToken,
  resolveSetupToken,
  setupTokenAccepts,
} from "./setup-token";

/** What the first admin acknowledged during setup, stored on `instance_setup`. */
type SetupConsent = {
  acknowledged_at: string;
  version: number;
};

const BCRYPT_ROUNDS = 10;
const CONSENT_VERSION = 1;

/** What the setup wizard collects. Strings are trimmed by the caller. */
export type SetupInput = {
  token: string;
  organizationName: string;
  clinicName: string;
  clinicCountry: string;
  clinicCity: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  acknowledgedDataResponsibility: boolean;
};

export type SetupOutcome =
  | { kind: "completed"; userId: string; clinicId: string }
  | { kind: "already-complete" }
  | { kind: "invalid-token" }
  | { kind: "invalid-input"; field: keyof SetupInput; message: string };

/** Stores the admin's email and name the way every user's are stored. */
export const normaliseSetupInput = (input: SetupInput): SetupInput => ({
  ...input,
  adminEmail: normaliseEmail(input.adminEmail),
  adminName: normaliseName(input.adminName),
});

const invalid = (field: keyof SetupInput, message: string): SetupOutcome => ({
  kind: "invalid-input",
  field,
  message,
});

/** Checks the input before any database work; `null` when it is acceptable. */
export const validateSetupInput = (input: SetupInput): SetupOutcome | null => {
  if (input.organizationName === "") {
    return invalid("organizationName", "Enter your organization's name");
  }
  if (input.clinicName === "")
    return invalid("clinicName", "Enter a clinic name");
  if (input.adminName === "") return invalid("adminName", "Enter your name");
  if (!/^[^\s@]+@[^\s@]+$/.test(input.adminEmail)) {
    return invalid("adminEmail", "Enter a valid email address");
  }
  if (input.adminEmail === SEED_ADMIN_EMAIL) {
    return invalid("adminEmail", "Use your own email address");
  }
  const password = checkPassword(input.adminPassword);
  if (!password.ok) return invalid("adminPassword", password.reason);
  if (!input.acknowledgedDataResponsibility) {
    return invalid(
      "acknowledgedDataResponsibility",
      "Confirm that you are responsible for this data",
    );
  }
  return null;
};

const BCRYPT_ALPHABET =
  "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const unmatchableBcryptHash = (): string =>
  `$2b$14$${Array.from(
    randomBytes(53),
    (byte) => BCRYPT_ALPHABET[byte % BCRYPT_ALPHABET.length],
  ).join("")}`;

/** Renames the seed install's clinic, or creates one if it is gone. */
const claimClinic = async (
  trx: Transaction<DB>,
  input: SetupInput,
): Promise<string> => {
  const seedAdmin = await trx
    .selectFrom("users")
    .select("clinic_id")
    .where("email", "=", SEED_ADMIN_EMAIL)
    .executeTakeFirst();
  const seedClinicId = seedAdmin?.clinic_id ?? null;

  const details = {
    name: input.clinicName,
    country: input.clinicCountry === "" ? null : input.clinicCountry,
    city: input.clinicCity === "" ? null : input.clinicCity,
  };

  if (seedClinicId !== null) {
    const renamed = await trx
      .updateTable("clinics")
      .set({ ...details, updated_at: sql`now()`, last_modified: sql`now()` })
      .where("id", "=", seedClinicId)
      .executeTakeFirst();
    if (renamed.numUpdatedRows > 0n) return seedClinicId;
  }

  const clinicId = uuidV1();
  await trx
    .insertInto("clinics")
    .values({
      id: clinicId,
      ...details,
      address: null,
      is_deleted: false,
      is_archived: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    })
    .execute();
  return clinicId;
};

const createSuperAdmin = async (
  trx: Transaction<DB>,
  input: SetupInput,
  clinicId: string,
  passwordHash: string,
): Promise<string> => {
  const userId = uuidV1();
  await trx
    .insertInto("users")
    .values({
      id: userId,
      name: input.adminName,
      role: "super_admin",
      email: input.adminEmail,
      hashed_password: passwordHash,
      instance_url: null,
      clinic_id: clinicId,
      is_deleted: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    })
    .execute();

  await trx
    .insertInto("user_clinic_permissions")
    .values({
      user_id: userId,
      clinic_id: clinicId,
      ...UserClinicPermissions.getRolePermissions("super_admin"),
      created_by: userId,
      last_modified_by: userId,
      created_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .execute();

  return userId;
};

/** Soft-deletes the seed admin so it can never sign in again. */
const retireSeedAdmin = (trx: Transaction<DB>) =>
  trx
    .updateTable("users")
    .set({
      is_deleted: true,
      deleted_at: sql`now()`,
      hashed_password: unmatchableBcryptHash(),
      updated_at: sql`now()`,
      last_modified: sql`now()`,
    })
    .where("email", "=", SEED_ADMIN_EMAIL)
    .execute();

const saveOrganizationName = (
  trx: Transaction<DB>,
  name: string,
  userId: string,
) =>
  trx
    .insertInto("app_config")
    .values({
      namespace: "organization",
      key: "organization-name",
      value: name,
      data_type: "string",
      display_name: "Organization Name",
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      last_modified_by: userId,
    })
    .onConflict((conflict) =>
      conflict.columns(["namespace", "key"]).doUpdateSet({
        value: name,
        updated_at: sql`now()`,
        last_modified: sql`now()`,
        last_modified_by: userId,
      }),
    )
    .execute();

export type TokenCheck =
  { kind: "valid" } | { kind: "already-complete" } | { kind: "invalid-token" };

/** Whether `token` unlocks setup right now, without changing anything. */
export const checkSetupToken = async (
  db: Kysely<DB>,
  token: string,
  configured: ConfiguredSetupToken = resolveSetupToken(),
): Promise<TokenCheck> => {
  const setup = await db
    .selectFrom("instance_setup")
    .select(["token", "completed_at"])
    .where("id", "=", 1)
    .executeTakeFirst();

  if (!setup) return { kind: "already-complete" };
  if (setup.completed_at !== null) return { kind: "already-complete" };
  if (!setupTokenAccepts(token, setup.token, configured)) {
    return { kind: "invalid-token" };
  }
  return { kind: "valid" };
};

/**
 * Creates the first super admin, claims the seed clinic, retires the seed admin
 * and closes setup, in one transaction. The locked setup row means concurrent
 * submissions have exactly one winner.
 */
export const completeSetup = async (
  db: Kysely<DB>,
  rawInput: SetupInput,
  configured: ConfiguredSetupToken = resolveSetupToken(),
): Promise<SetupOutcome> => {
  const input = normaliseSetupInput(rawInput);
  const problem = validateSetupInput(input);
  if (problem !== null) return problem;

  // Cheap check before bcrypt, so a caller without the token cannot make the
  // server hash; the locked check inside the transaction is the real one.
  const precheck = await checkSetupToken(db, input.token, configured);
  if (precheck.kind !== "valid") return precheck;

  const passwordHash = await bcrypt.hash(input.adminPassword, BCRYPT_ROUNDS);

  return db.transaction().execute(async (trx) => {
    const setup = await trx
      .selectFrom("instance_setup")
      .select(["token", "completed_at"])
      .where("id", "=", 1)
      .forUpdate()
      .executeTakeFirst();

    if (!setup) return { kind: "already-complete" };
    if (setup.completed_at !== null) return { kind: "already-complete" };
    if (!setupTokenAccepts(input.token, setup.token, configured)) {
      return { kind: "invalid-token" };
    }

    const clinicId = await claimClinic(trx, input);
    const userId = await createSuperAdmin(trx, input, clinicId, passwordHash);
    await retireSeedAdmin(trx);
    await saveOrganizationName(trx, input.organizationName, userId);

    const consent: SetupConsent = {
      acknowledged_at: new Date().toISOString(),
      version: CONSENT_VERSION,
    };
    await trx
      .updateTable("instance_setup")
      .set({
        completed_at: sql`now()`,
        completed_by: userId,
        token: null,
        consent: JSON.stringify(consent),
        updated_at: sql`now()`,
      })
      .where("id", "=", 1)
      .execute();

    return { kind: "completed", userId, clinicId };
  });
};
