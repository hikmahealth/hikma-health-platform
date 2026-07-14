import db from "@/db";
import { Either, Option, Schema } from "effect";
import {
  type ColumnType,
  type Generated,
  type Selectable,
  type Insertable,
  type Updateable,
  sql,
} from "kysely";
import Token from "./token";
import bcrypt from "bcrypt";
import { createServerOnlyFn } from "@tanstack/react-start";
import { v1 as uuidV1 } from "uuid";
import cloneDeep from "lodash/cloneDeep";
import UserClinicPermissions from "./user-clinic-permissions";

namespace User {
  // export type T = {
  //   id: string;
  //   name: string;
  //   role: string;
  //   email: string;
  //   hashed_password: string;
  //   instance_url: Option.Option<string>;
  //   clinic_id: Option.Option<string>;
  //   is_deleted: boolean;
  //   created_at: Date;
  //   updated_at: Date;
  //   last_modified: Date;
  //   server_created_at: Date;
  //   deleted_at: Option.Option<Date>;
  // };

  export const ROLES = {
    REGISTRAR: "registrar",
    PROVIDER: "provider",
    ADMIN: "admin",
    SUPER_ADMIN: "super_admin",
  } as const;

  export const roles = [
    ROLES.REGISTRAR,
    ROLES.PROVIDER,
    ROLES.ADMIN,
    ROLES.SUPER_ADMIN,
  ] as const;

  export const RoleSchema = Schema.Union(
    Schema.Literal(ROLES.REGISTRAR),
    Schema.Literal(ROLES.PROVIDER),
    Schema.Literal(ROLES.ADMIN),
    Schema.Literal(ROLES.SUPER_ADMIN),
  );

  export type RoleT = typeof RoleSchema.Encoded;

  export const UserSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    role: RoleSchema,
    email: Schema.String,
    hashed_password: Schema.String,
    instance_url: Schema.OptionFromNullOr(Schema.String),
    clinic_id: Schema.OptionFromNullOr(Schema.String),
    is_deleted: Schema.Boolean,
    created_at: Schema.Union(
      Schema.DateFromString,
      Schema.Date,
      Schema.DateFromSelf,
    ),
    updated_at: Schema.Union(
      Schema.Date,
      Schema.DateFromString,
      Schema.DateFromSelf,
    ),
    last_modified: Schema.Union(
      Schema.Date,
      Schema.DateFromString,
      Schema.DateFromSelf,
    ),
    server_created_at: Schema.Union(
      Schema.Date,
      Schema.DateFromString,
      Schema.DateFromSelf,
    ),
    deleted_at: Schema.OptionFromNullOr(
      Schema.Union(Schema.Date, Schema.DateFromString),
    ),
  });

  export type T = typeof UserSchema.Type;
  export type EncodedT = typeof UserSchema.Encoded;

  // TODO: To add capabilities in prod, we need a new table and migration
  export const CapabilitySchema = Schema.Union(
    // Manage other users
    Schema.Literal("create_user"),
    Schema.Literal("read_user"),
    Schema.Literal("update_user"),
    Schema.Literal("delete_user"),

    // Manage patients
    Schema.Literal("create_patient"),
    Schema.Literal("read_patient"),
    Schema.Literal("update_patient"),
    Schema.Literal("delete_patient"),

    // Manage all patients (including other clinics and departments)
    Schema.Literal("create_all_patient"),
    Schema.Literal("read_all_patient"),
    Schema.Literal("update_all_patient"),
    Schema.Literal("delete_all_patient"),

    // Manage clinics
    Schema.Literal("create_clinic"),
    Schema.Literal("read_clinic"),
    Schema.Literal("update_clinic"),
    Schema.Literal("delete_clinic"),

    // Manage system
    Schema.Literal("manage_system"),
    Schema.Literal("view_analytics"),
    Schema.Literal("manage_permissions"),

    // Manage reports
    Schema.Literal("create_report"),
    Schema.Literal("read_report"),
    Schema.Literal("update_report"),
    Schema.Literal("delete_report"),
  );

  export const CAPABILITIES: Record<string, typeof CapabilitySchema.Type> = {
    // User management
    CREATE_USER: "create_user",
    READ_USER: "read_user",
    UPDATE_USER: "update_user",
    DELETE_USER: "delete_user",

    // Clinic Patient management
    CREATE_PATIENT: "create_patient",
    READ_PATIENT: "read_patient",
    UPDATE_PATIENT: "update_patient",
    DELETE_PATIENT: "delete_patient",

    // All Clinics patient management
    CREATE_ALL_PATIENT: "create_all_patient",
    READ_ALL_PATIENT: "read_all_patient",
    UPDATE_ALL_PATIENT: "update_all_patient",
    DELETE_ALL_PATIENT: "delete_all_patient",

    // Clinic management
    CREATE_CLINIC: "create_clinic",
    READ_CLINIC: "read_clinic",
    UPDATE_CLINIC: "update_clinic",
    DELETE_CLINIC: "delete_clinic",

    // System administration
    MANAGE_SYSTEM: "manage_system",
    VIEW_ANALYTICS: "view_analytics",
    MANAGE_PERMISSIONS: "manage_permissions",

    // Report operations
    CREATE_REPORT: "create_report",
    READ_REPORT: "read_report",
    UPDATE_REPORT: "update_report",
    DELETE_REPORT: "delete_report",
  };

  const ADMIN_CAPABILITIES = [
    CAPABILITIES.CREATE_USER,
    CAPABILITIES.READ_USER,
    CAPABILITIES.UPDATE_USER,
    CAPABILITIES.DELETE_USER,

    // Clinic Patient management
    CAPABILITIES.CREATE_PATIENT,
    CAPABILITIES.READ_PATIENT,
    CAPABILITIES.UPDATE_PATIENT,
    CAPABILITIES.DELETE_PATIENT,

    // All Clinics patient management
    CAPABILITIES.CREATE_ALL_PATIENT,
    CAPABILITIES.READ_ALL_PATIENT,
    CAPABILITIES.UPDATE_ALL_PATIENT,
    CAPABILITIES.DELETE_ALL_PATIENT,

    // Clinic management
    CAPABILITIES.CREATE_CLINIC,
    CAPABILITIES.READ_CLINIC,
    CAPABILITIES.UPDATE_CLINIC,
    CAPABILITIES.DELETE_CLINIC,

    // System administration
    CAPABILITIES.MANAGE_SYSTEM,
    CAPABILITIES.VIEW_ANALYTICS,
    CAPABILITIES.MANAGE_PERMISSIONS,
    CAPABILITIES.CREATE_REPORT,
    CAPABILITIES.READ_REPORT,
    CAPABILITIES.UPDATE_REPORT,
    CAPABILITIES.DELETE_REPORT,
  ];

  export const ROLE_CAPABILITIES: Record<
    typeof User.RoleSchema.Type,
    (typeof CapabilitySchema.Type)[]
  > = {
    admin: [...ADMIN_CAPABILITIES],
    provider: [
      CAPABILITIES.READ_USER,
      CAPABILITIES.CREATE_PATIENT,
      CAPABILITIES.READ_PATIENT,
      CAPABILITIES.UPDATE_PATIENT,
      CAPABILITIES.DELETE_PATIENT,
      CAPABILITIES.CREATE_REPORT,
      CAPABILITIES.READ_REPORT,
      CAPABILITIES.UPDATE_REPORT,
    ],
    super_admin: [...ADMIN_CAPABILITIES],
  };

  export function secureMask(user: User.T): User.T {
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      hashed_password: "***************",
      instance_url: Option.none(),
      clinic_id: Option.none(),
      is_deleted: user.is_deleted,
      created_at: user.created_at,
      updated_at: user.updated_at,
      last_modified: user.last_modified,
      server_created_at: user.server_created_at,
      deleted_at: user.deleted_at,
    };
  }

  export function getInitials(user: User.T | User.EncodedT): string {
    return user.name
      .split(" ")
      .map((name) => name[0].toUpperCase())
      .join("");
  }

  export const fromDbEntry = (
    dbUser: User.Table.Users,
  ): Either.Either<User.T, Error> => {
    return Schema.decodeUnknownEither(UserSchema)(dbUser);
  };

  export namespace Table {
    /**
     * If set to true, this table is always pushed regardless of the the last sync date times. All sync events push to mobile the latest table.
     * IMPORTANT: If ALWAYS_PUSH_TO_MOBILE is true, content of the table should never be edited on the client or pushed to the server from mobile. its one way only.
     * */
    export const ALWAYS_PUSH_TO_MOBILE = false;
    export const name = "users";
    /** The name of the table in the mobile database */
    export const mobileName = "users";
    export const columns = {
      id: "id",
      name: "name",
      role: "role",
      email: "email",
      hashed_password: "hashed_password",
      instance_url: "instance_url",
      clinic_id: "clinic_id",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
    };

    export interface T {
      id: string;
      name: string;
      role: string;
      email: string;
      hashed_password: string;
      instance_url: string | null;
      clinic_id: string | null;
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

    export type Users = Selectable<T>;
    export type NewUsers = Insertable<T>;
    export type UsersUpdate = Updateable<T>;
  }

  /**
   * Authenticate a user by signing them in using an email and password
   * The method also creates a token for the user, with an expiry date 2 hours in the future
   * @param {string} email - The user's email
   * @param {string} password - The user's password
   * @param {number} validHours - The number of hours the token is valid for
   * @returns {Promise<{ user: User.EncodedT; token: string }>} - The user if authentication is successful, null otherwise
   */
  // export const signIn = createServerOnlyFn(
  //   async (
  //     email: string,
  //     password: string,
  //     validHours: number = 2,
  //   ): Promise<{ user: User.EncodedT; token: string }> => {
  //     const user = await db
  //       .selectFrom(Table.name)
  //       .where("email", "=", email)
  //       .where("is_deleted", "=", false)
  //       .selectAll()
  //       .executeTakeFirst();

  //     if (!user) {
  //       throw new Error("User not found");
  //     }

  //     const hashedPassword = user.hashed_password;
  //     if (!(await bcrypt.compare(password, hashedPassword))) {
  //       throw new Error("Invalid password");
  //     }

  //     const userEntry = User.fromDbEntry(user);
  //     if (Either.isLeft(userEntry)) {
  //       throw new Error("Failed to parse user data");
  //     }

  //     const token = await Token.create(
  //       user.id,
  //       new Date(Date.now() + validHours * 60 * 60 * 1000),
  //     );

  //     return {
  //       user: Schema.encodeSync(UserSchema)(userEntry.right),
  //       token,
  //     };
  //   },
  // );
export const signIn = createServerOnlyFn(
    async (
      email: string,
      password: string,
      validHours: number = 2,
    ): Promise<{ user: User.EncodedT; token: string }> => {
      
      console.log("[SIGN IN DEBUG] 1. Searching for email:", email);
      
      const user = await db
        .selectFrom(Table.name)
        .where("email", "=", email)
        .where("is_deleted", "=", false)
        .selectAll()
        .executeTakeFirst();

      if (!user) {
        console.log("[SIGN IN DEBUG] 2. FAILED: User not found in DB.");
        throw new Error("User not found");
      }

      console.log("[SIGN IN DEBUG] 3. User found. Checking password...");
      const hashedPassword = user.hashed_password;
      const isPasswordValid = await bcrypt.compare(password, hashedPassword);
      
      if (!isPasswordValid) {
        console.log(`[SIGN IN DEBUG] 4. FAILED: Password mismatch.`);
        throw new Error("Invalid password");
      }

      console.log("[SIGN IN DEBUG] 5. Password valid. Validating against UserSchema...");
      const userEntry = User.fromDbEntry(user);
      
      if (Either.isLeft(userEntry)) {
        console.log("[SIGN IN DEBUG] 6. FAILED: Schema parsing rejected the DB data!", userEntry.left);
        throw new Error("Failed to parse user data");
      }

      console.log("[SIGN IN DEBUG] 7. SUCCESS! Generating token...");
      const token = await Token.create(
        user.id,
        new Date(Date.now() + validHours * 60 * 60 * 1000),
      );

      return {
        user: Schema.encodeSync(UserSchema)(userEntry.right),
        token,
      };
    },
  );
  
  /**
   * Signs a user out and invalidates their token
   * @param {string} token - The user's token
   * @returns {Promise<void>} - Resolves when the token is invalidated
   */
  export const signOut = createServerOnlyFn(
    async (token: string): Promise<void> => {
      await Token.invalidate(token);
    },
  );

  export namespace API {
    /**
     * Create a new user / registration
     * @param {User.EncodedT} user - The user to create
     * @returns {Promise<User.EncodedT["id"] | null>} - The created user
     */
    export const create = createServerOnlyFn(
      async (
        user: User.EncodedT,
        creatorId: string,
      ): Promise<User.EncodedT["id"] | null> => {
        const entry = User.fromDbEntry(user);
        if (Either.isLeft(entry)) return null;

        const saltRounds = 10;
        const salt = bcrypt.genSaltSync(saltRounds);
        const hash = bcrypt.hashSync(user.hashed_password, salt);

        const userId = uuidV1();

        await db.transaction().execute(async (trx) => {
          await trx
            .insertInto(Table.name)
            .values({
              id: userId,
              name: user.name,
              role: user.role,
              email: user.email,
              hashed_password: hash,
              instance_url: user.instance_url,
              clinic_id: user.clinic_id,
              is_deleted: user.is_deleted,
              updated_at: sql`now()`,
              last_modified: sql`now()`,
              server_created_at: sql`now()`,
              deleted_at: null,
              created_at: sql`now()`,
            })
            .execute();

          const userPermissions = UserClinicPermissions.getRolePermissions(
            user.role,
          );
          await trx
            .insertInto(UserClinicPermissions.Table.name)
            .values({
              user_id: userId,
              clinic_id: user.clinic_id || "",
              can_delete_records: userPermissions.can_delete_records,
              can_view_history: userPermissions.can_view_history,
              can_edit_records: userPermissions.can_edit_records,
              can_register_patients: userPermissions.can_register_patients,
              is_clinic_admin: userPermissions.is_clinic_admin,
              created_by: creatorId,
              created_at: sql`now()`,
              updated_at: sql`now()`,
              last_modified_by: creatorId,
            })
            .execute();
        });

        return userId;
      },
    );
    /**
     * Get all users
     * @returns {Promise<User.EncodedT[]>} - The list of users
     */
    export const getAll = createServerOnlyFn(
      async (): Promise<User.EncodedT[]> => {
        const users = await db
          .selectFrom(Table.name)
          .where("is_deleted", "=", false)
          .selectAll()
          .execute();

        const entries = users.map(User.fromDbEntry);

        // Throws an error if encoding fails. Something to keep in mind!
        return entries
          .filter(Either.isRight)
          .map((e) => Schema.encodeSync(UserSchema)(e.right));
      },
    );

    /**
     * get a user by their id
     * @param {string} id - The id of the user
     * @returns {Promise<User.EncodedT | null>} - The user
     */
    export const getById = createServerOnlyFn(
      async (id: string): Promise<User.EncodedT | null> => {
        const user = await db
          .selectFrom(Table.name)
          .where("id", "=", id)
          .where("is_deleted", "=", false)
          .selectAll()
          .executeTakeFirst();

        if (user === null) return null;

        const entry = User.fromDbEntry(user);
        if (Either.isLeft(entry)) return null;

        return Schema.encodeSync(UserSchema)(entry.right);
      },
    );

    /**
     * retrieve all users with a first name "james"
     * @param {string} name - The first name of the user
     * @returns {Promise<User.EncodedT[]>} - The list of users
     */
    export const getByName = createServerOnlyFn(
      async (name: string): Promise<User.EncodedT[]> => {
        const users = await db
          .selectFrom(Table.name)
          .where("name", "=", name)
          .where("is_deleted", "=", false)
          .selectAll()
          .execute();

        return users
          .map(User.fromDbEntry)
          .filter(Either.isRight)
          .map((e) => Schema.encodeSync(UserSchema)(e.right));
      },
    );

    export const update = createServerOnlyFn(
      async (
        id: string,
        user: Omit<
          User.EncodedT,
          | "hashed_password"
          | "created_at"
          | "updated_at"
          | "last_modified"
          | "server_created_at"
          | "deleted_at"
        >,
      ): Promise<User.EncodedT["id"] | null> => {
        await db
          .updateTable(Table.name)
          .set({
            name: user.name,
            role: user.role,
            email: user.email,
            instance_url: user.instance_url,
            clinic_id: user.clinic_id,
            is_deleted: user.is_deleted,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .where("id", "=", id)
          .execute();

        return id;
      },
    );

    // Specific methods to update passwords
    export const updatePassword = createServerOnlyFn(
      async (id: string, password: string): Promise<User.EncodedT["id"]> => {
        const saltRounds = 10;
        const salt = bcrypt.genSaltSync(saltRounds);
        const hashed_password = bcrypt.hashSync(password, salt);

        await db
          .updateTable(Table.name)
          .set({
            hashed_password,
            updated_at: sql`now()`,
            last_modified: sql`now()`,
          })
          .where("id", "=", id)
          .execute();

        return id;
      },
    );

    export const softDelete = createServerOnlyFn(
      async (id: string): Promise<void> => {
        await db
          .updateTable(Table.name)
          .set({
            is_deleted: true,
            deleted_at: sql`now()::timestamp with time zone`,
            updated_at: sql`now()::timestamp with time zone`,
            last_modified: sql`now()::timestamp with time zone`,
          })
          .where("id", "=", id)
          .execute();
      },
    );
  }
}

export default User;
