import type {
  ColumnType,
  Generated,
  Selectable,
  Insertable,
  Updateable,
} from "kysely";
import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import { sql } from "kysely";
import { toSafeDateString } from "@/lib/utils";

type ProfileValueType =
  | "string"
  | "numeric"
  | "integer"
  | "boolean"
  | "datetime"
  | "json";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

namespace PatientRiskProfile {
  export type T = {
    id: string;
    patient_id: string;
    clinic_id: string | null;
    kind: string;
    source: string;
    target: string | null;
    version: string;
    value_type: ProfileValueType;
    string_value: string | null;
    boolean_value: boolean | null;
    integer_value: number | null;
    numerical_value: number | null;
    datetime_value: Date | null;
    json_value: Json | null;
    metadata: Json | null;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
    last_modified: Date;
    server_created_at: Date;
    deleted_at: Date | null;
  };

  export type EncodedT = {
    id: string;
    patient_id: string;
    clinic_id: string | null;
    kind: string;
    source: string;
    target: string | null;
    version: string;
    value_type: ProfileValueType;
    string_value: string | null;
    boolean_value: boolean | null;
    integer_value: number | null;
    numerical_value: number | null;
    datetime_value: Date | null;
    json_value: Json | null;
    metadata: Json | null;
    is_deleted: boolean;
    created_at: Date;
    updated_at: Date;
    last_modified: Date;
    server_created_at: Date;
    deleted_at: Date | null;
  };

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the last sync date times.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be
     * edited on the client or pushed to the server from mobile — it is one-way only.
     * Risk profiles are computed server-side and flow down to mobile read-only.
     */
    export const ALWAYS_PUSH_TO_MOBILE = true;
    export const name = "patient_risk_profiles";
    export const mobileName = "patient_risk_profiles";
    export const columns = {
      id: "id",
      patient_id: "patient_id",
      clinic_id: "clinic_id",
      kind: "kind",
      source: "source",
      target: "target",
      version: "version",
      value_type: "value_type",
      string_value: "string_value",
      boolean_value: "boolean_value",
      integer_value: "integer_value",
      numerical_value: "numerical_value",
      datetime_value: "datetime_value",
      json_value: "json_value",
      metadata: "metadata",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
    };

    export interface T {
      id: string;
      patient_id: string;
      clinic_id: string | null;
      kind: string;
      source: string;
      target: string | null;
      version: string;
      value_type: ColumnType<
        ProfileValueType,
        ProfileValueType,
        ProfileValueType
      >;
      string_value: string | null;
      boolean_value: boolean | null;
      integer_value: number | null;
      numerical_value: ColumnType<
        string | null,
        number | string | null | undefined,
        number | string | null
      >;
      datetime_value: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      json_value: ColumnType<
        Json | null,
        string | null | undefined,
        string | null
      >;
      metadata: ColumnType<
        Json | null,
        string | null | undefined,
        string | null
      >;
      is_deleted: Generated<boolean>;
      created_at: Generated<ColumnType<Date, string | undefined, never>>;
      updated_at: Generated<
        ColumnType<Date, string | undefined, string | undefined>
      >;
      last_modified: Generated<ColumnType<Date, string | undefined, never>>;
      server_created_at: Generated<ColumnType<Date, string | undefined, never>>;
      deleted_at: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
    }

    export type PatientRiskProfiles = Selectable<T>;
    export type NewPatientRiskProfile = Insertable<T>;
    export type PatientRiskProfileUpdate = Updateable<T>;
  }

  export namespace API {
    /**
     * Upsert a patient risk profile.
     * The unique constraint is on (patient_id, kind, source),
     * so each patient has at most one profile value per kind + source pair.
     */
    export const upsert = createServerOnlyFn(
      async (profile: PatientRiskProfile.EncodedT) => {
        return await db
          .insertInto(PatientRiskProfile.Table.name)
          .values({
            id: profile.id,
            patient_id: profile.patient_id,
            clinic_id: profile.clinic_id ?? null,
            kind: profile.kind,
            source: profile.source,
            target: profile.target ?? null,
            version: profile.version,
            value_type: profile.value_type,
            string_value: profile.string_value ?? null,
            boolean_value: profile.boolean_value ?? null,
            integer_value: profile.integer_value ?? null,
            numerical_value: profile.numerical_value ?? null,
            datetime_value: profile.datetime_value
              ? sql`${toSafeDateString(profile.datetime_value)}::timestamp with time zone`
              : null,
            json_value:
              profile.json_value != null
                ? JSON.stringify(profile.json_value)
                : null,
            metadata:
              profile.metadata != null
                ? JSON.stringify(profile.metadata)
                : null,
            is_deleted: profile.is_deleted,
            created_at: sql`${toSafeDateString(profile.created_at)}::timestamp with time zone`,
            updated_at: sql`${toSafeDateString(profile.updated_at)}::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
            server_created_at: sql`now()::timestamp with time zone`,
            deleted_at: null,
          })
          .onConflict((oc) =>
            oc
              .columns(["patient_id", "kind", "source"])
              .doUpdateSet({
                value_type: (eb) => eb.ref("excluded.value_type"),
                target: (eb) => eb.ref("excluded.target"),
                version: (eb) => eb.ref("excluded.version"),
                string_value: (eb) => eb.ref("excluded.string_value"),
                boolean_value: (eb) => eb.ref("excluded.boolean_value"),
                integer_value: (eb) => eb.ref("excluded.integer_value"),
                numerical_value: (eb) => eb.ref("excluded.numerical_value"),
                datetime_value: (eb) => eb.ref("excluded.datetime_value"),
                json_value: (eb) => eb.ref("excluded.json_value"),
                metadata: (eb) => eb.ref("excluded.metadata"),
                is_deleted: (eb) => eb.ref("excluded.is_deleted"),
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
              })
              // Only update when the incoming record is newer than the stored one
              .where(
                sql<boolean>`excluded.updated_at > patient_risk_profiles.updated_at`,
              ),
          )
          .executeTakeFirst();
      },
    );

    /**
     * Soft-delete a patient risk profile by id.
     */
    export const softDelete = createServerOnlyFn(async (id: string) => {
      await db
        .updateTable(PatientRiskProfile.Table.name)
        .set({
          is_deleted: true,
          deleted_at: sql`now()::timestamp with time zone`,
          updated_at: sql`now()::timestamp with time zone`,
          last_modified: sql`now()::timestamp with time zone`,
        })
        .where("id", "=", id)
        .execute();
    });
  }

  export namespace Sync {
    export const upsertFromDelta = createServerOnlyFn(
      async (delta: PatientRiskProfile.EncodedT) => {
        return API.upsert(delta);
      },
    );

    export const deleteFromDelta = createServerOnlyFn(async (id: string) => {
      return API.softDelete(id);
    });
  }
}

export default PatientRiskProfile;
