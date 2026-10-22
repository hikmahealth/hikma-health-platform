import { Option, Schema, Either } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  sql,
} from "kysely";
import db from "@/db";
import { createServerOnlyFn } from "@tanstack/react-start";
import { v1 as uuidV1 } from "uuid";
import User from "./user";
import UserClinicPermissions from "./user-clinic-permissions";
import Token from "./token";
import { getCookie } from "@tanstack/react-start/server";

namespace Clinic {
  export const ClinicSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.OptionFromNullOr(Schema.String),
    address: Schema.OptionFromNullOr(Schema.String),
    country: Schema.OptionFromNullOr(Schema.String),
    city: Schema.OptionFromNullOr(Schema.String),
    is_deleted: Schema.OptionFromNullOr(Schema.Boolean),
    created_at: Schema.DateFromSelf,
    updated_at: Schema.DateFromSelf,
    last_modified: Schema.DateFromSelf,
    server_created_at: Schema.DateFromSelf,
    deleted_at: Schema.OptionFromNullOr(Schema.DateFromSelf),
    is_archived: Schema.Boolean,
  });
  export type T = typeof ClinicSchema.Type;
  export type EncodedT = typeof ClinicSchema.Encoded;

  export const fromDbEntry = (
    entry: Clinic.Table.Clinics,
  ): Either.Either<Clinic.T, Error> => {
    return Schema.decodeUnknownEither(ClinicSchema)(entry);
  };
  // export type T = {
  //   id: string;
  //   name: string | null;
  //   is_deleted: Option.Option<boolean>;
  //   created_at: Date;
  //   updated_at: Date;
  //   last_modified: Date;
  //   server_created_at: Date;
  //   deleted_at: Option.Option<Date>;
  // };

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = true;
    export const name = "clinics";
    /** The name of the table in the mobile database */
    export const mobileName = "clinics";
    export const columns = {
      id: "id",
      name: "name",
      address: "address",
      country: "country",
      city: "city",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
      is_archived: "is_archived",
    };

    export interface T {
      id: string;
      name: string | null;
      address: string | null;
      country: string | null;
      city: string | null;
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
      is_archived: ColumnType<boolean, boolean, boolean>;
    }
    export type Clinics = Selectable<T>;
    export type NewClinics = Insertable<T>;
    export type ClinicsUpdate = Updateable<T>;
  }

  export namespace API {
    /**
     * Set the archived status of a clinic
     * @param {string} id of the clinic
     * @param {boolean} isArchived - The new archived status of the clinic
     */
    export const setArchivedStatus = createServerOnlyFn(
      async (id: string, isArchived: boolean = false): Promise<void> => {
        await db
          .updateTable(Clinic.Table.name)
          .where("id", "=", id)
          .set({
            is_archived: isArchived,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .execute();
      },
    );
  }

  /**
   * Returns a list of all the clinics
   * @returns {Promise<(EncodedT & { users?: { id: string; clinic_id: string }[] })[]>} - List of clinics
   */
  export const getAll = createServerOnlyFn(
    async (
      options: { includeUsers: boolean } = { includeUsers: true },
    ): Promise<
      (EncodedT & { users?: { id: string; clinic_id: string }[] })[]
    > => {
      const baseQuery = db
        .selectFrom(Clinic.Table.name)
        .where("is_deleted", "=", false)
        .where("is_archived", "=", false);

      if (options.includeUsers) {
        const query = sql`
          SELECT
              clinic.*,
              COALESCE(
                ARRAY_AGG(
                  JSON_BUILD_OBJECT(
                    'id', users.id,
                    'clinic_id', users.clinic_id
                  )
                ) FILTER (WHERE users.id IS NOT NULL),
                ARRAY[]::json[]
              ) as users
            FROM  ${sql.id(Clinic.Table.name)} clinic
            LEFT JOIN users ON users.clinic_id = clinic.id
            WHERE clinic.is_deleted = false AND clinic.is_archived = false
            GROUP BY clinic.id
        `.compile(db);

        const result = await db.executeQuery(query);

        return result.rows;
      }

      const result = await baseQuery.selectAll().execute();

      return result;
    },
  );

  /**
   * Deletes a clinic given an id, and that the clinic does not have any registered members,
   * If there are registered members, the clinic will not be deleted and an error will be thrown
   * TODO: We should prevent deleting clinics, only archive them
   * @param {string} id - The id of the clinic to delete
   * @returns {Promise<void>} - Resolves when the clinic is deleted
   * @throws {Error} - If the clinic has registered users
   */
  export const softDelete = createServerOnlyFn(
    async (id: string): Promise<void> => {
      // First check if there are any users registered to this clinic
      const usersInClinic = await db
        .selectFrom(User.Table.name)
        .where("clinic_id", "=", id)
        .where("is_deleted", "=", false)
        .selectAll()
        .execute();

      // If there are users, throw an error
      if (usersInClinic.length > 0) {
        throw new Error(
          `Cannot delete clinic with ID ${id} because it has ${usersInClinic.length} registered users. Please remove or reassign all users before deleting the clinic.`,
        );
      }

      // If no users are found, proceed with deletion
      await db
        .updateTable(Clinic.Table.name)
        .set({
          is_deleted: true,
          deleted_at: new Date().toISOString(),
        })
        .where("id", "=", id)
        .execute();
    },
  );

  /**
   * Trims a free-text field and collapses unset/blank values to null so the
   * optional location columns always store null rather than empty strings.
   */
  const toNullableText = (value?: string | null): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };

  /**
   * Creates or updates a clinic. If the clinic id is not provided, a new clinic
   * is created. The optional location fields (address, country, city) default
   * to null when not provided.
   * @param {string} [id] - The id of the clinic to update
   * @param {string} name - The name of the clinic
   * @param {string} [address] - Optional free-text street address
   * @param {string} [country] - Optional country
   * @param {string} [city] - Optional city
   * @returns {Promise<void>} - Resolves when the clinic is saved
   */
  export const save = createServerOnlyFn(
    async ({
      id,
      name,
      address,
      country,
      city,
    }: {
      id?: string;
      name: string;
      address?: string | null;
      country?: string | null;
      city?: string | null;
    }): Promise<string> => {
      const token = getCookie("token");
      if (!token) {
        return Promise.reject(new Error("Unauthorized"));
      }
      const userOption = await Token.getUser(token);
      if (Option.isNone(userOption)) {
        return Promise.reject(new Error("Unauthorized"));
      }

      const currentUser = userOption.value;

      if (typeof id !== "string" || id.length <= 5) {
        const clinicId = uuidV1();
        await db
          .insertInto(Clinic.Table.name)
          .values({
            id: clinicId,
            name,
            address: toNullableText(address),
            country: toNullableText(country),
            city: toNullableText(city),
            is_deleted: false,
            created_at: sql`now()`,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
            server_created_at: sql`now()`,
            deleted_at: null,
            is_archived: false,
          })
          .execute();

        // get all the current super admins
        // going to ignore any errors here
        UserClinicPermissions.API.newClinicCreated(clinicId, currentUser.id);
        return clinicId;
      } else {
        await db
          .updateTable(Clinic.Table.name)
          .set({
            name,
            address: toNullableText(address),
            country: toNullableText(country),
            city: toNullableText(city),
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .where("id", "=", id)
          .execute();
        return id;
      }
    },
  );

  /**
   * Get by id
   * @param {string} id - The id of the clinic to get
   * @returns {Promise<Clinic.EncodedT>} - The clinic
   */
  export const getById = createServerOnlyFn(
    async (id: string): Promise<Clinic.EncodedT> => {
      const result = await db
        .selectFrom(Clinic.Table.name)
        .where("id", "=", id)
        .where("is_deleted", "=", false)
        .selectAll()
        .executeTakeFirstOrThrow();
      return result;
    },
  );
}

export default Clinic;
