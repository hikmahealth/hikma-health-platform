import { describe, it, expect, vi, afterEach } from "vitest";
import { sql } from "kysely";
import { v1 as uuidV1 } from "uuid";
import { testDb } from "../setup";

// Models importing `@/db` (Token, the command router) resolve to the test DB.
vi.mock("@/db", () => ({ default: testDb }));

import { commandAppRouter } from "@/integrations/trpc/router";
import Token from "@/models/token";

// INV-27: the can_register_patients gate must hold server-side, not just in the UI.
// register_patient re-codes every error as INTERNAL_SERVER_ERROR, so denials are
// asserted on the message, not a 403.

const createdIds: {
  patients: string[];
  tokens: string[];
  users: string[];
  clinics: string[];
} = { patients: [], tokens: [], users: [], clinics: [] };

const insertClinic = async (): Promise<string> => {
  const id = uuidV1();
  createdIds.clinics.push(id);
  await testDb
    .insertInto("clinics")
    .values({
      id,
      name: "AuthZ Test Clinic",
      is_deleted: false,
      is_archived: false,
      created_at: sql`now()`,
      updated_at: sql`now()`,
      last_modified: sql`now()`,
      server_created_at: sql`now()`,
      deleted_at: null,
    })
    .execute();
  return id;
};

const insertUser = async (clinicId: string): Promise<string> => {
  const id = uuidV1();
  createdIds.users.push(id);
  await testDb
    .insertInto("users")
    .values({
      id,
      name: "AuthZ Test User",
      role: "registrar",
      email: `authz-${id}@example.com`,
      hashed_password: "not-a-real-hash",
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
  return id;
};

const insertPermissions = async (
  userId: string,
  clinicId: string,
  canRegisterPatients: boolean,
): Promise<void> => {
  await testDb
    .insertInto("user_clinic_permissions")
    .values({
      user_id: userId,
      clinic_id: clinicId,
      can_register_patients: canRegisterPatients,
      created_by: null,
      last_modified_by: null,
      created_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .execute();
};

const mintToken = async (userId: string): Promise<string> => {
  const token = await Token.create(userId, new Date(Date.now() + 60 * 60 * 1000));
  createdIds.tokens.push(token);
  return token;
};

// Cleanup in FK-safe dependency order.
afterEach(async () => {
  for (const id of createdIds.patients)
    await testDb.deleteFrom("patients").where("id", "=", id).execute();
  for (const token of createdIds.tokens)
    await testDb.deleteFrom("tokens").where("token", "=", Token.hash(token)).execute();
  for (const id of createdIds.users) {
    await testDb
      .deleteFrom("user_clinic_permissions")
      .where("user_id", "=", id)
      .execute();
    await testDb.deleteFrom("users").where("id", "=", id).execute();
  }
  for (const id of createdIds.clinics)
    await testDb.deleteFrom("clinics").where("id", "=", id).execute();

  createdIds.patients.length = 0;
  createdIds.tokens.length = 0;
  createdIds.users.length = 0;
  createdIds.clinics.length = 0;
});

describe("register_patient — server-side permission gate (INV-27)", () => {
  it("rejects registration when the user lacks can_register_patients, and writes nothing", async () => {
    const clinicId = await insertClinic();
    const userId = await insertUser(clinicId);
    await insertPermissions(userId, clinicId, false);
    const token = await mintToken(userId);
    const caller = commandAppRouter.createCaller({ authHeader: `Bearer ${token}` });

    const patientId = uuidV1();
    createdIds.patients.push(patientId); // track in case the write leaks

    await expect(
      caller.register_patient({
        patient: {
          id: patientId,
          given_name: "Blocked",
          surname: "Patient",
          primary_clinic_id: clinicId,
        },
      }),
    ).rejects.toThrow(/can_register_patients/);

    // The gate runs before the insert transaction — no row must exist.
    const row = await testDb
      .selectFrom("patients")
      .select("id")
      .where("id", "=", patientId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("allows registration when the user holds can_register_patients (positive control)", async () => {
    const clinicId = await insertClinic();
    const userId = await insertUser(clinicId);
    await insertPermissions(userId, clinicId, true);
    const token = await mintToken(userId);
    const caller = commandAppRouter.createCaller({ authHeader: `Bearer ${token}` });

    const patientId = uuidV1();
    createdIds.patients.push(patientId);

    const result = await caller.register_patient({
      patient: {
        id: patientId,
        given_name: "Allowed",
        surname: "Patient",
        primary_clinic_id: clinicId,
      },
    });
    expect(result.patient_id).toBe(patientId);

    const row = await testDb
      .selectFrom("patients")
      .select("id")
      .where("id", "=", patientId)
      .executeTakeFirst();
    expect(row?.id).toBe(patientId);
  });

  it("rejects when the bearer token is missing (unauthenticated bypass attempt)", async () => {
    const caller = commandAppRouter.createCaller({ authHeader: null });

    const patientId = uuidV1();
    createdIds.patients.push(patientId); // track in case the write leaks

    await expect(
      caller.register_patient({
        patient: { id: patientId, given_name: "NoAuth", surname: "Patient" },
      }),
    ).rejects.toThrow();

    // Authentication must reject before any insert — no row must exist.
    const row = await testDb
      .selectFrom("patients")
      .select("id")
      .where("id", "=", patientId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});
