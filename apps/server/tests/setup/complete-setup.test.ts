// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import type { Kysely } from "kysely";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import { createPgliteKysely, migrateToLatest } from "../helpers/pglite-kysely";
import {
  type SetupInput,
  checkSetupToken,
  completeSetup,
} from "@/lib/setup/complete-setup";
import {
  SETUP_TOKEN_PLACEHOLDER,
  getOrCreateSetupToken,
  resolveSetupToken,
} from "@/lib/setup/setup-token";

const SEED_EMAIL = "admin@hikmahealth.org";
const ENV_TOKEN = "an-operator-chosen-passphrase-0001";
const UNSET = { kind: "unset" } as const;

let db: Kysely<DB>;
let token: string;

const input = (overrides: Partial<SetupInput> = {}): SetupInput => ({
  token,
  organizationName: "Northern Health Collective",
  clinicName: "North Wing",
  clinicCountry: "Kenya",
  clinicCity: "Nairobi",
  adminName: "Amina Clinic Lead",
  adminEmail: "amina@example.org",
  adminPassword: "clinic-north-wing-2026-ledger",
  acknowledgedDataResponsibility: true,
  ...overrides,
});

const setupRow = () =>
  db.selectFrom("instance_setup").selectAll().executeTakeFirstOrThrow();

const userCount = async () =>
  Number(
    (
      await db
        .selectFrom("users")
        .select(db.fn.countAll().as("count"))
        .executeTakeFirstOrThrow()
    ).count,
  );

beforeEach(async () => {
  db = createPgliteKysely() as Kysely<DB>;
  await migrateToLatest(db);
  const state = await getOrCreateSetupToken(db, UNSET);
  if (state.kind !== "generated") throw new Error(`unexpected ${state.kind}`);
  token = state.token;
});

afterEach(async () => {
  await db.destroy();
});

describe("completeSetup", () => {
  it("creates a super admin who can sign in with the chosen password", async () => {
    const outcome = await completeSetup(db, input(), UNSET);

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") return;
    const admin = await db
      .selectFrom("users")
      .selectAll()
      .where("id", "=", outcome.userId)
      .executeTakeFirstOrThrow();
    expect(admin.role).toBe("super_admin");
    expect(admin.email).toBe("amina@example.org");
    expect(admin.clinic_id).toBe(outcome.clinicId);
    expect(
      await bcrypt.compare(
        "clinic-north-wing-2026-ledger",
        admin.hashed_password,
      ),
    ).toBe(true);
  });

  it("stores the admin email in lowercase, as the web login sends it", async () => {
    const outcome = await completeSetup(
      db,
      input({ adminEmail: "Amina@Example.ORG" }),
      UNSET,
    );
    if (outcome.kind !== "completed") throw new Error(outcome.kind);

    const admin = await db
      .selectFrom("users")
      .select("email")
      .where("id", "=", outcome.userId)
      .executeTakeFirstOrThrow();
    expect(admin.email).toBe("amina@example.org");
  });

  it("grants the admin every super admin permission in the clinic", async () => {
    const outcome = await completeSetup(db, input(), UNSET);
    if (outcome.kind !== "completed") throw new Error(outcome.kind);

    const permissions = await db
      .selectFrom("user_clinic_permissions")
      .selectAll()
      .where("user_id", "=", outcome.userId)
      .execute();
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      clinic_id: outcome.clinicId,
      can_register_patients: true,
      is_clinic_admin: true,
      can_delete_patient_records: true,
    });
  });

  it("renames the seed clinic instead of adding a second one", async () => {
    const outcome = await completeSetup(db, input(), UNSET);
    if (outcome.kind !== "completed") throw new Error(outcome.kind);

    const clinics = await db.selectFrom("clinics").selectAll().execute();
    expect(clinics).toHaveLength(1);
    expect(clinics[0]).toMatchObject({
      id: outcome.clinicId,
      name: "North Wing",
      country: "Kenya",
      city: "Nairobi",
    });
  });

  it("retires the seed admin with deleted_at set, so sync sees it", async () => {
    await completeSetup(db, input(), UNSET);

    const seed = await db
      .selectFrom("users")
      .selectAll()
      .where("email", "=", SEED_EMAIL)
      .executeTakeFirstOrThrow();
    expect(seed.is_deleted).toBe(true);
    expect(seed.deleted_at).toBeInstanceOf(Date);
    expect(seed.hashed_password).toMatch(/^\$2b\$14\$[./A-Za-z0-9]{53}$/);
  });

  it("closes setup and clears the token", async () => {
    const outcome = await completeSetup(db, input(), UNSET);
    if (outcome.kind !== "completed") throw new Error(outcome.kind);

    const row = await setupRow();
    expect(row.completed_at).toBeInstanceOf(Date);
    expect(row.completed_by).toBe(outcome.userId);
    expect(row.token).toBeNull();
    expect(row.consent).toMatchObject({ version: 1 });
  });

  it("stores the organization name where the settings page reads it", async () => {
    await completeSetup(db, input(), UNSET);

    const config = await db
      .selectFrom("app_config")
      .select(["value", "data_type"])
      .where("namespace", "=", "organization")
      .where("key", "=", "organization-name")
      .executeTakeFirstOrThrow();
    expect(config).toEqual({
      value: "Northern Health Collective",
      data_type: "string",
    });
  });

  it("rejects a wrong token and changes nothing", async () => {
    const before = await userCount();

    const outcome = await completeSetup(db, input({ token: "WRONG" }), UNSET);

    expect(outcome).toEqual({ kind: "invalid-token" });
    expect(await userCount()).toBe(before);
    expect((await setupRow()).completed_at).toBeNull();
  });

  it("only ever lets one submission win", async () => {
    const outcomes = await Promise.all([
      completeSetup(db, input({ adminEmail: "first@example.org" }), UNSET),
      completeSetup(db, input({ adminEmail: "second@example.org" }), UNSET),
      completeSetup(db, input({ adminEmail: "third@example.org" }), UNSET),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.kind === "completed"),
    ).toHaveLength(1);
    const superAdmins = await db
      .selectFrom("users")
      .select("email")
      .where("role", "=", "super_admin")
      .where("is_deleted", "=", false)
      .execute();
    expect(superAdmins).toHaveLength(1);
  });

  it("refuses to run again once setup is complete", async () => {
    await completeSetup(db, input(), UNSET);

    const again = await completeSetup(
      db,
      input({ adminEmail: "intruder@example.org" }),
      UNSET,
    );

    expect(again).toEqual({ kind: "already-complete" });
  });

  it("accepts only the env token when one is configured", async () => {
    const configured = resolveSetupToken(ENV_TOKEN);

    expect(await completeSetup(db, input(), configured)).toEqual({
      kind: "invalid-token",
    });
    expect(
      (await completeSetup(db, input({ token: ENV_TOKEN }), configured)).kind,
    ).toBe("completed");
  });

  it("falls back to the stored token when the env holds the placeholder", async () => {
    const configured = resolveSetupToken(SETUP_TOKEN_PLACEHOLDER);

    expect(
      await completeSetup(
        db,
        input({ token: SETUP_TOKEN_PLACEHOLDER }),
        configured,
      ),
    ).toEqual({ kind: "invalid-token" });
    expect((await completeSetup(db, input(), configured)).kind).toBe(
      "completed",
    );
  });

  it.each<[Partial<SetupInput>, keyof SetupInput]>([
    [{ adminPassword: "password1" }, "adminPassword"],
    [{ adminPassword: "short" }, "adminPassword"],
    [{ adminPassword: "x".repeat(73) }, "adminPassword"],
    [{ adminEmail: "not-an-email" }, "adminEmail"],
    [{ adminEmail: SEED_EMAIL }, "adminEmail"],
    [{ adminEmail: "Admin@HikmaHealth.org" }, "adminEmail"],
    [
      { acknowledgedDataResponsibility: false },
      "acknowledgedDataResponsibility",
    ],
    [{ clinicName: "" }, "clinicName"],
    [{ organizationName: "" }, "organizationName"],
    [{ adminName: "" }, "adminName"],
  ])("rejects %j on %s without writing", async (overrides, field) => {
    const before = await userCount();

    const outcome = await completeSetup(db, input(overrides), UNSET);

    expect(outcome).toMatchObject({ kind: "invalid-input", field });
    expect(await userCount()).toBe(before);
    expect((await setupRow()).completed_at).toBeNull();
  });
});

describe("checkSetupToken", () => {
  it("accepts the stored token and rejects anything else", async () => {
    expect(await checkSetupToken(db, token, UNSET)).toEqual({ kind: "valid" });
    expect(await checkSetupToken(db, "WRONG", UNSET)).toEqual({
      kind: "invalid-token",
    });
  });

  it("reports completion instead of validity once setup is done", async () => {
    await completeSetup(db, input(), UNSET);

    expect(await checkSetupToken(db, token, UNSET)).toEqual({
      kind: "already-complete",
    });
  });
});
