import { Either, Option, Schema } from "effect";
import { forEach } from "ramda";
import type {
  ColumnType,
  Generated,
  Selectable,
  Insertable,
  Updateable,
  JSONColumnType,
  CompiledQuery,
  Transaction,
} from "kysely";
import db from "@/db";
import type { TableName, Database } from "@/db";
import { sql } from "kysely";
import { createServerOnlyFn } from "@tanstack/react-start";
import { v1 as uuidv1 } from "uuid";
import PatientAdditionalAttribute from "./patient-additional-attribute";
import Appointment from "./appointment";
import Prescription from "./prescription";
import Visit from "./visit";
import Event from "./event";
import {
  isValidUUID,
  safeJSONParse,
  safeStringify,
  civilDateFromInstant,
  civilDateFromLocalDate,
  toSafeDateString,
} from "@/lib/utils";
import { uuidv7 } from "uuidv7";
import UserClinicPermissions from "./user-clinic-permissions";
import PrescriptionItem from "./prescription-items";
import PatientVital from "./patient-vital";
import PatientProblem from "./patient-problem";
import PatientObservation from "./patient-observation";
import { cascadeSoftDelete } from "@/lib/soft-delete-registry";
import { Logger } from "@hikmahealth/js-utils";

namespace Patient {
  // export type T = {
  //   id: string;
  //   given_name: Option.Option<string>;
  //   surname: Option.Option<string>;
  //   date_of_birth: Option.Option<Date>;
  //   citizenship: Option.Option<string>;
  //   hometown: Option.Option<string>;
  //   phone: Option.Option<string>;
  //   sex: Option.Option<string>;
  //   camp: Option.Option<string>;
  //   additional_data: Record<string, any>;
  //   image_timestamp: Option.Option<Date>;
  //   metadata: Record<string, any>;
  //   photo_url: Option.Option<string>;
  //   government_id: Option.Option<string>;
  //   external_patient_id: Option.Option<string>;
  //   is_deleted: boolean;
  //   created_at: Date;
  //   updated_at: Date;
  //   last_modified: Date;
  //   server_created_at: Date;
  //   deleted_at: Option.Option<Date>;
  // };

  // export type WithAttributes = T & {
  //   additional_attributes: {
  //     [uuid: string]: {
  //       attribute: string;
  //       boolean_value: Option.Option<boolean | string>;
  //       date_value: Option.Option<Date | string>;
  //       number_value: Option.Option<number | string>;
  //       string_value: Option.Option<string>;
  //     };
  //   };
  // };

  export type RenderedRows = {
    columns: string[];
    values: Array<Record<string, string | number | Date | boolean>>;
  };

  export const PatientSchema = Schema.Struct({
    id: Schema.String,
    given_name: Schema.OptionFromNonEmptyTrimmedString,
    surname: Schema.OptionFromNonEmptyTrimmedString,
    date_of_birth: Schema.OptionFromNullOr(Schema.DateFromSelf),
    citizenship: Schema.OptionFromNonEmptyTrimmedString,
    hometown: Schema.OptionFromNonEmptyTrimmedString,
    phone: Schema.OptionFromNonEmptyTrimmedString,
    sex: Schema.OptionFromNonEmptyTrimmedString,
    camp: Schema.OptionFromNonEmptyTrimmedString,
    additional_data: Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),
    image_timestamp: Schema.OptionFromNullOr(Schema.Date),
    metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    photo_url: Schema.OptionFromNullOr(Schema.String),
    government_id: Schema.OptionFromNullOr(Schema.String),
    external_patient_id: Schema.OptionFromNullOr(Schema.String),
    is_deleted: Schema.Boolean,
    created_at: Schema.DateFromSelf,
    updated_at: Schema.DateFromSelf,
    last_modified: Schema.DateFromSelf,
    server_created_at: Schema.DateFromSelf,
    deleted_at: Schema.OptionFromNullOr(Schema.DateFromSelf),
    primary_clinic_id: Schema.OptionFromNullOr(Schema.String),
    last_modified_by: Schema.OptionFromNullOr(Schema.String),
  });

  // Define the additional attributes schema
  export const AttributeValueSchema = Schema.Struct({
    attribute: Schema.String,
    boolean_value: Schema.OptionFromNullOr(
      Schema.Union(Schema.Boolean, Schema.String),
    ),
    date_value: Schema.OptionFromNullOr(
      Schema.Union(Schema.Date, Schema.String),
    ),
    number_value: Schema.OptionFromNullOr(
      Schema.Union(Schema.Number, Schema.String),
    ),
    string_value: Schema.OptionFromNullOr(Schema.String),
  });

  // Define the patient with attributes schema
  export const PatientWithAttributesSchema = Schema.extend(
    PatientSchema,
    Schema.Struct({
      additional_attributes: Schema.Record({
        key: Schema.String,
        value: AttributeValueSchema,
      }),
    }),
  );

  export type T = typeof PatientWithAttributesSchema.Type;
  export type EncodedT = typeof PatientWithAttributesSchema.Encoded;
  export type Attributes = typeof AttributeValueSchema.Type;

  //   export type T = Schema.Type<typeof PatientSchema>;
  //   export type WithAttributes = Schema.Type<typeof PatientWithAttributesSchema>;

  /**
   * Convert a database entry into a T entry
   * @param entry The database entry
   * @returns {Either.Either<Patient.T, Error>} entry
   */
  export const fromDbEntry = (
    entry: Table.Patients & { additional_attributes: Record<string, any> },
  ): Either.Either<Patient.T, Error> => {
    const additional_attributes = Object.entries(
      entry.additional_attributes,
    ).reduce((acc, [key, value]) => {
      acc[key as keyof Patient.Attributes] =
        Schema.decodeUnknownEither(AttributeValueSchema)(value);
      // acc[key as keyof Patient.Attributes] = {
      //   attribute: value.attribute,
      //   boolean_value: Option.fromNullable(value.boolean_value),
      //   date_value: Option.fromNullable(value.date_value),
      //   number_value: Option.fromNullable(value.number_value),
      //   string_value: Option.fromNullable(value.string_value),
      // };
      return acc;
    }, {}) as Patient.Attributes;
    // entry.additional_attributes
    const patient = Schema.decodeUnknownEither(PatientSchema)({
      ...entry,
      date_of_birth: entry.date_of_birth,
    }).pipe(
      Either.map(
        (patient) =>
          ({
            ...patient,

            additional_attributes,
          }) as unknown as Patient.T,
      ),
    );

    return patient;
  };

  export namespace Table {
    export const ALWAYS_PUSH_TO_MOBILE = false;
    export const name = "patients";
    /** The name of the table in the mobile database */
    export const mobileName = "patients";
    export const columns = {
      id: "id",
      given_name: "given_name",
      surname: "surname",
      date_of_birth: "date_of_birth",
      citizenship: "citizenship",
      hometown: "hometown",
      phone: "phone",
      sex: "sex",
      camp: "camp",
      additional_data: "additional_data",
      image_timestamp: "image_timestamp",
      metadata: "metadata",
      photo_url: "photo_url",
      government_id: "government_id",
      external_patient_id: "external_patient_id",
      is_deleted: "is_deleted",
      created_at: "created_at",
      updated_at: "updated_at",
      last_modified: "last_modified",
      server_created_at: "server_created_at",
      deleted_at: "deleted_at",
      primary_clinic_id: "primary_clinic_id",
      last_modified_by: "last_modified_by",
    };

    export interface T {
      id: string;
      given_name: string | null;
      surname: string | null;
      date_of_birth: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      citizenship: string | null;
      hometown: string | null;
      phone: string | null;
      sex: string | null;
      camp: string | null;
      additional_data: JSONColumnType<Record<string, any>>;
      image_timestamp: ColumnType<
        Date | null,
        string | null | undefined,
        string | null
      >;
      metadata: JSONColumnType<Record<string, any>>;
      photo_url: string | null;
      government_id: string | null;
      external_patient_id: string | null;
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
      primary_clinic_id: string | null;
      last_modified_by: string | null;
    }

    export type Patients = Selectable<T>;
    export type NewPatients = Insertable<T>;
    export type PatientsUpdate = Updateable<T>;
  }

  // METHODS START HERE:

  /**
   * Register a new patient
   * @param {{baseFields: Patient.T, additionalAttributes: PatientAdditionalAttribute.T[]}} patient
   */
  export const register = createServerOnlyFn(
    async ({
      baseFields,
      additionalAttributes,
    }: {
      baseFields: Patient.T;
      additionalAttributes: PatientAdditionalAttribute.T[];
    }) => {
      // PermissionsCheck
      const clinicIds =
        await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
          "can_register_patients",
        );

      const primaryClinicId = Option.getOrElse(
        baseFields.primary_clinic_id,
        () => null,
      );

      if (primaryClinicId && !clinicIds.includes(primaryClinicId)) {
        throw new Error("Unauthorized");
      }

      const patientId = uuidv1();

      const ptObject = {
        id: patientId,
        given_name: Option.getOrElse(baseFields.given_name, () => null),
        surname: Option.getOrElse(baseFields.surname, () => null),
        // Civil date — toISOString() would re-read it as an instant and shift
        // the day.
        date_of_birth: Option.getOrElse(
          Option.map(
            baseFields.date_of_birth,
            (date) => sql`${civilDateFromInstant(date)}::date`,
          ),
          () => null,
        ),
        citizenship: Option.getOrElse(baseFields.citizenship, () => null),
        hometown: Option.getOrElse(baseFields.hometown, () => null),
        phone: Option.getOrElse(baseFields.phone, () => null),
        sex: Option.getOrElse(baseFields.sex, () => null),
        camp: Option.getOrElse(baseFields.camp, () => null),
        additional_data: sql`${JSON.stringify(
          baseFields.additional_data,
        )}::jsonb`,
        image_timestamp: Option.getOrElse(
          Option.map(
            baseFields.image_timestamp,
            (date) => sql`${date.toISOString()}::timestamp with time zone`,
          ),
          () => null,
        ),
        metadata: sql`${JSON.stringify(baseFields.metadata)}::jsonb`,
        photo_url: Option.getOrElse(baseFields.photo_url, () => null),
        government_id: Option.getOrElse(baseFields.government_id, () => null),
        external_patient_id: Option.getOrElse(
          baseFields.external_patient_id,
          () => null,
        ),
        is_deleted: baseFields.is_deleted,
        created_at: sql`now()::timestamp with time zone`,
        updated_at: sql`now()::timestamp with time zone`,
        last_modified: sql`now()::timestamp with time zone`,
        server_created_at: sql`now()::timestamp with time zone`,
        deleted_at: Option.getOrElse(
          Option.map(
            baseFields.deleted_at,
            (date) => sql`${date.toISOString()}::timestamp with time zone`,
          ),
          () => null,
        ),
        primary_clinic_id: primaryClinicId,
        last_modified_by: Option.getOrElse(
          baseFields.last_modified_by,
          () => null,
        ),
      };

      const patientAttributes = additionalAttributes.map((attr) => ({
        id: uuidv1(),
        patient_id: patientId,
        attribute_id: attr.attribute_id,
        attribute: attr.attribute,
        number_value: Option.getOrElse(attr.number_value, () => null),
        string_value: Option.getOrElse(attr.string_value, () => null),
        date_value: Option.getOrElse(
          Option.map(attr.date_value, (date) => new Date(date)),
          () => null,
        ),
        boolean_value: Option.getOrElse(attr.boolean_value, () => null),
        metadata: attr.metadata,
        is_deleted: baseFields.is_deleted,
        created_at: sql`now()::timestamp with time zone`,
        updated_at: sql`now()::timestamp with time zone`,
        last_modified: sql`now()::timestamp with time zone`,
        server_created_at: sql`now()::timestamp with time zone`,
        deleted_at: Option.getOrElse(
          Option.map(
            baseFields.deleted_at,
            (date) => sql`${date.toISOString()}::timestamp with time zone`,
          ),
          () => null,
        ),
      }));

      return await db.transaction().execute(async (trx) => {
        await trx
          .insertInto(Patient.Table.name)
          .values(ptObject)
          .returning("id")
          .executeTakeFirstOrThrow();

        await trx
          .insertInto(PatientAdditionalAttribute.Table.name)
          .values(patientAttributes)
          .executeTakeFirst();

        return { patientId };
      });
    },
  );

  /**
   * Format date fields in a patient record for transport.
   *
   * Instants become ISO strings. date_of_birth is a *civil date* and becomes
   * "YYYY-MM-DD" — it carries no timezone, so it must not be serialized as an
   * instant.
   *
   * @param patient Patient record with potential Date objects
   */
  const formatPatientDates = <T extends Partial<Table.Patients>>(
    patient: T,
  ) => ({
    ...patient,
    created_at:
      patient.created_at instanceof Date
        ? patient.created_at.toISOString()
        : patient.created_at,
    updated_at:
      patient.updated_at instanceof Date
        ? patient.updated_at.toISOString()
        : patient.updated_at,
    last_modified:
      patient.last_modified instanceof Date
        ? patient.last_modified.toISOString()
        : patient.last_modified,
    deleted_at:
      patient.deleted_at instanceof Date
        ? patient.deleted_at.toISOString()
        : patient.deleted_at,
    // Never toISOString() — that would shift the day on any server not running
    // on UTC.
    date_of_birth: civilDateFromLocalDate(patient.date_of_birth),
  });

  /**
   * Build the base SQL query for retrieving patients with their additional attributes
   * Exported so the clinic-scoping clause can be tested directly with an explicit
   * clinicIds list, without the cookie-bound token resolution used at the API layer.
   * @returns SQL query template
   */
  export const buildPatientAttributesBaseQuery = (clinicIds: string[]) => sql`
    SELECT
      p.*,
      COALESCE(json_object_agg(
        pa.attribute_id,
        json_build_object(
          'attribute', pa.attribute,
          'number_value', pa.number_value,
          'string_value', pa.string_value,
          'date_value', pa.date_value,
          'boolean_value', pa.boolean_value
        )
      ) FILTER (WHERE pa.attribute_id IS NOT NULL), '{}') AS additional_attributes
    FROM patients p
    LEFT JOIN patient_additional_attributes pa ON p.id = pa.patient_id
    WHERE p.is_deleted = false
    AND (${clinicIds.length > 0 ? sql`p.primary_clinic_id IN (${sql.join(clinicIds)})  OR p.primary_clinic_id IS NULL` : sql`p.primary_clinic_id IS NULL`})
  `;

  /**
   * Build a date range AND clause for a given column.
   * If only start is set: >= start. If only end: <= end. If both: between inclusive.
   */
  const buildDateRangeClause = (
    column: string,
    start?: string,
    end?: string,
  ) => {
    if (start && end) {
      return sql`AND ${sql.raw(column)} >= ${start}::timestamptz AND ${sql.raw(column)} <= ${end}::timestamptz`;
    }
    if (start) {
      return sql`AND ${sql.raw(column)} >= ${start}::timestamptz`;
    }
    if (end) {
      return sql`AND ${sql.raw(column)} <= ${end}::timestamptz`;
    }
    return sql``;
  };

  /**
   * Build an EXISTS clause requiring the patient to have at least one recorded
   * activity (event, vital, problem, or prescription) in the date range.
   */
  const buildVisitsDateClause = (start?: string, end?: string) => {
    if (!start && !end) return sql``;

    const rangeCheck = (col: string) =>
      start && end
        ? sql`AND ${sql.raw(col)} >= ${start}::timestamptz AND ${sql.raw(col)} <= ${end}::timestamptz`
        : start
          ? sql`AND ${sql.raw(col)} >= ${start}::timestamptz`
          : sql`AND ${sql.raw(col)} <= ${end}::timestamptz`;

    return sql`AND (
      EXISTS (
        SELECT 1 FROM events e
        WHERE e.patient_id = p.id AND e.is_deleted = false
        ${rangeCheck("e.created_at")}
      )
      OR EXISTS (
        SELECT 1 FROM patient_vitals v
        WHERE v.patient_id = p.id AND v.is_deleted = false
        ${rangeCheck("v.timestamp")}
      )
      OR EXISTS (
        SELECT 1 FROM patient_problems pp
        WHERE pp.patient_id = p.id AND pp.is_deleted = false
        ${rangeCheck("COALESCE(pp.onset_date, pp.created_at)")}
      )
      OR EXISTS (
        SELECT 1 FROM prescriptions rx
        WHERE rx.patient_id = p.id AND rx.is_deleted = false
        ${rangeCheck("rx.prescribed_at")}
      )
    )`;
  };

  /**
   * Build the base SQL for retrieving patients by a given list of ids and their additional attributes
   * @param ids List of patient ids
   * @returns SQL query template
   */
  const buildPatientAttributesByIdQuery = (
    clinicIds: string[],
    patientIds: string[],
  ) => sql`
    SELECT
      p.*,
      COALESCE(json_object_agg(
        pa.attribute_id,
        json_build_object(
          'attribute', pa.attribute,
          'number_value', pa.number_value,
          'string_value', pa.string_value,
          'date_value', pa.date_value,
          'boolean_value', pa.boolean_value
        )
      ) FILTER (WHERE pa.attribute_id IS NOT NULL), '{}') AS additional_attributes
    FROM patients p
    LEFT JOIN patient_additional_attributes pa ON p.id = pa.patient_id
    WHERE p.is_deleted = false
    AND (${clinicIds.length > 0 ? sql`p.primary_clinic_id IN (${sql.join(clinicIds)}) OR p.primary_clinic_id IS NULL` : sql`p.primary_clinic_id IS NULL`})
    AND p.id IN (${sql.join(patientIds)})
    GROUP BY p.id
  `;

  /**
   * Execute a patient query and format the results
   * @param query The SQL query to execute
   * @returns Formatted patient records
   */
  export const executePatientQuery = createServerOnlyFn(
    async <T extends { rows: any[] }>(query: CompiledQuery<unknown>) => {
      const result = await db.executeQuery<
        Table.Patients & { additional_attributes: Record<string, any> }
      >(query);

      return result.rows.map(formatPatientDates);
    },
  );

  type PatientsQueryResult = {
    patients: Patient.EncodedT[];
    pagination: {
      offset: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  };

  export namespace API {
    /**
     * Resolve a patient's primary clinic without token/cookie scoping, for
     * authorization on non-cookie code paths (e.g. mobile Basic-auth uploads).
     * Returns null when the patient does not exist; `primaryClinicId` is null
     * for legacy patients with no primary clinic set.
     */
    export const getClinicScope = createServerOnlyFn(
      async (
        patientId: string,
      ): Promise<{ primaryClinicId: string | null } | null> => {
        const row = await db
          .selectFrom(Table.name)
          .select(["id", "primary_clinic_id"])
          .where("id", "=", patientId)
          .where("is_deleted", "=", false)
          .executeTakeFirst();
        if (!row) return null;
        return { primaryClinicId: row.primary_clinic_id ?? null };
      },
    );

    export const getById = createServerOnlyFn(
      async (patientId: string): Promise<Patient.EncodedT> => {
        // permissions check
        const clinicIds =
          await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
            "can_view_history",
          );
        // ${patientIds.length > 0 ? sql`AND p.id IN (${sql.join(patientIds)})` : ""}
        //

        // Build the query using the base query and adding pagination
        const query = sql`
        ${buildPatientAttributesByIdQuery(clinicIds, [patientId])}
      `.compile(db);

        const patient = await executePatientQuery(query);

        return patient?.[0];
      },
    );
    /**
     * Get all patients with their additional attributes
     * @param {Object} options - Pagination and filter options
     * @param {number} [options.limit] - Maximum number of records to return
     * @param {number} [options.offset=0] - Number of records to skip
     * @param {boolean} [options.includeCount=false] - Whether to include total count in response
     * @returns Object containing patients array and pagination metadata
     */
    export const getAllWithAttributes = createServerOnlyFn(
      async (options?: {
        limit?: number;
        offset?: number;
        includeCount?: boolean;
      }): Promise<PatientsQueryResult> => {
        const { limit, offset = 0, includeCount = false } = options || {};

        // permissions check
        const clinicIds =
          await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
            "can_view_history",
          );

        // Build the query using the base query and adding pagination
        const query = sql`
        ${buildPatientAttributesBaseQuery(clinicIds)}
        GROUP BY p.id
        ORDER BY p.updated_at DESC
        ${offset ? sql`OFFSET ${offset}` : sql``}
        ${limit ? sql`LIMIT ${limit}` : sql``}
      `.compile(db);

        // Execute the query and get formatted patients
        const patients = await executePatientQuery(query);

        // Get total count if requested
        let totalCount = 0;
        if (includeCount) {
          const countQuery = sql`
          SELECT COUNT(*) as total
          FROM patients
          WHERE is_deleted = false
        `.compile(db);

          const countResult = await db.executeQuery<{ total: number }>(
            countQuery,
          );
          totalCount = countResult.rows[0]?.total || 0;
        }

        // Return both the patients and pagination metadata
        return {
          // @ts-expect-error issue with dates being turned into iso strings
          patients,
          pagination: {
            offset,
            limit: limit ?? 0,
            total: totalCount,
            hasMore: limit ? patients.length === limit : false,
          },
        };
      },
    );

    /**
     * Search for patients by name and other fields
     * @param options Search and pagination options
     * @param {string} options.searchQuery The search string to look for in patient fields
     * @param {number} [options.limit] - Maximum number of records to return
     * @param {number} [options.offset=0] - Number of records to skip
     * @param {boolean} [options.includeCount=false] - Whether to include total count in response
     * @returns Object containing matching patients array and pagination metadata
     */
    export const search = createServerOnlyFn(
      async ({
        searchQuery,
        offset = 0,
        limit,
        includeCount = false,
        registrationDateStart,
        registrationDateEnd,
        visitsDateStart,
        visitsDateEnd,
        clinicIds: filterClinicIds,
      }: {
        searchQuery: string;
        offset?: number;
        limit?: number;
        includeCount?: boolean;
        registrationDateStart?: string;
        registrationDateEnd?: string;
        visitsDateStart?: string;
        visitsDateEnd?: string;
        clinicIds?: string[];
      }): Promise<PatientsQueryResult> => {
        const hasTextQuery = searchQuery && searchQuery.trim() !== "";
        const searchPattern = hasTextQuery ? `%${searchQuery}%` : "";

        // permissions check
        const clinicIds =
          await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
            "can_view_history",
          );

        // Build conditional SQL fragments for text search
        const textSearchClause = hasTextQuery
          ? sql`AND (
              LOWER(p.given_name) LIKE LOWER(${searchPattern})
              OR LOWER(p.surname) LIKE LOWER(${searchPattern})
              OR LOWER(COALESCE(p.phone, '')) LIKE LOWER(${searchPattern})
              OR LOWER(COALESCE(p.camp, '')) LIKE LOWER(${searchPattern})
              OR LOWER(COALESCE(p.citizenship, '')) LIKE LOWER(${searchPattern})
              OR LOWER(COALESCE(p.hometown, '')) LIKE LOWER(${searchPattern})
              OR LOWER(CAST(p.id AS TEXT)) = LOWER(${searchQuery})
              OR EXISTS (
                SELECT 1
                FROM patient_additional_attributes paa
                WHERE paa.patient_id = p.id
                AND (
                  LOWER(COALESCE(paa.string_value, '')) LIKE LOWER(${searchPattern})
                  OR CAST(paa.number_value AS TEXT) LIKE ${searchPattern}
                  OR CASE WHEN paa.boolean_value = true AND LOWER(${searchQuery}) IN ('true', 'yes', '1') THEN true
                      WHEN paa.boolean_value = false AND LOWER(${searchQuery}) IN ('false', 'no', '0') THEN true
                      ELSE false
                     END
                  OR LOWER(COALESCE(paa.attribute, '')) LIKE LOWER(${searchPattern})
                )
              )
            )`
          : sql``;

        // Registration date filter on p.created_at
        const regDateClause = buildDateRangeClause(
          "p.created_at",
          registrationDateStart,
          registrationDateEnd,
        );

        // Visits date filter — patient must have at least one event in the date range
        const visitsDateClause = buildVisitsDateClause(
          visitsDateStart,
          visitsDateEnd,
        );

        // Narrow results to specific primary clinics selected by the user
        const clinicFilterClause =
          filterClinicIds && filterClinicIds.length > 0
            ? sql`AND p.primary_clinic_id IN (${sql.join(filterClinicIds)})`
            : sql``;

        const query = sql`
      ${buildPatientAttributesBaseQuery(clinicIds)}
      ${textSearchClause}
      ${regDateClause}
      ${visitsDateClause}
      ${clinicFilterClause}
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      ${offset ? sql`OFFSET ${offset}` : sql``}
      ${limit ? sql`LIMIT ${limit}` : sql``}
    `.compile(db);

        const patients = await executePatientQuery(query);

        let totalCount = 0;
        if (includeCount) {
          const countQuery = sql`
          SELECT COUNT(*) as total
          FROM patients p
          WHERE p.is_deleted = false
          ${textSearchClause}
          ${regDateClause}
          ${visitsDateClause}
          ${clinicFilterClause}
        `.compile(db);

          const countResult = await db.executeQuery<{ total: number }>(
            countQuery,
          );
          totalCount = countResult.rows[0]?.total || 0;
        }

        return {
          patients,
          pagination: {
            offset,
            limit: limit ?? 0,
            total: totalCount,
            hasMore: limit ? patients.length === limit : false,
          },
        };
      },
    );

    /**
     * Upsert a patient record without the additional patient attributes
     */
    export const upsert = createServerOnlyFn(
      async (patient: Patient.EncodedT) => {
        // permissions check
        await UserClinicPermissions.API.isAuthorizedWithClinic(
          patient.primary_clinic_id,
          "can_register_patients",
        );
        // const clinicIds =
        //   await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
        //     "can_register_patients",
        //   );

        // if (
        //   patient.primary_clinic_id &&
        //   !clinicIds.includes(patient.primary_clinic_id)
        // ) {
        //   throw new Error("Unauthorized");
        // }
        return await upsert_core(patient);
      },
    );

    /**
     * Upsert a patient record without the additional patient attributes
     * SYNC ONLY METHOD
     */
    export const DANGEROUS_SYNC_ONLY_upsert = createServerOnlyFn(
      async (patient: Patient.EncodedT) => {
        return await upsert_core(patient);
      },
    );

    /**
     * The core logic for upserting a patient record without the additional patient attributes
     * without any authentication or authorization checks
     * DO NOT EXPORT OR CALL THIS OUTSIDE OF SYNC FUNCTIONS
     */
    const upsert_core = createServerOnlyFn(
      async (patient: Patient.EncodedT) => {
        const patientId =
          patient.id && isValidUUID(patient.id) ? patient.id : uuidv7();
        try {
          return await db
            .insertInto(Patient.Table.name)
            .values({
              id: patientId,
              given_name: patient.given_name,
              surname: patient.surname,
              // Civil date. Casting to timestamptz would resolve it against the
              // session timezone before Postgres casts it back down to `date`,
              // shifting the day whenever that timezone is not UTC.
              date_of_birth: patient.date_of_birth
                ? sql`${civilDateFromInstant(patient.date_of_birth)}::date`
                : null,
              citizenship: patient.citizenship,
              photo_url: patient.photo_url || null,
              image_timestamp: patient.image_timestamp || null,
              hometown: patient.hometown,
              additional_data: sql`${JSON.stringify(
                safeJSONParse(patient.additional_data, {}),
              )}::jsonb`,
              government_id: patient.government_id,
              external_patient_id: patient.external_patient_id,
              primary_clinic_id: patient.primary_clinic_id,
              last_modified_by: patient.last_modified_by,
              phone: patient.phone,
              sex: patient.sex,
              camp: patient.camp,
              metadata: sql`${JSON.stringify(
                safeJSONParse(patient.metadata, {}),
              )}::jsonb`,
              is_deleted: patient.is_deleted,
              created_at: sql`${toSafeDateString(
                patient.created_at,
              )}::timestamp with time zone`,
              updated_at: sql`${toSafeDateString(
                patient.updated_at,
              )}::timestamp with time zone`,
              last_modified: sql`now()::timestamp with time zone`,
              server_created_at: sql`now()::timestamp with time zone`,
              deleted_at: null,
            })
            .onConflict((oc) =>
              oc
                .column("id")
                .doUpdateSet({
                  given_name: (eb) => eb.ref("excluded.given_name"),
                  surname: (eb) => eb.ref("excluded.surname"),
                  date_of_birth: (eb) => eb.ref("excluded.date_of_birth"),
                  citizenship: (eb) => eb.ref("excluded.citizenship"),
                  photo_url: (eb) => eb.ref("excluded.photo_url"),
                  image_timestamp: (eb) => eb.ref("excluded.image_timestamp"),
                  hometown: (eb) => eb.ref("excluded.hometown"),
                  additional_data: (eb) => eb.ref("excluded.additional_data"),
                  government_id: (eb) => eb.ref("excluded.government_id"),
                  external_patient_id: (eb) =>
                    eb.ref("excluded.external_patient_id"),
                  primary_clinic_id: (eb) =>
                    eb.ref("excluded.primary_clinic_id"),
                  last_modified_by: (eb) => eb.ref("excluded.last_modified_by"),
                  phone: (eb) => eb.ref("excluded.phone"),
                  sex: (eb) => eb.ref("excluded.sex"),
                  camp: (eb) => eb.ref("excluded.camp"),
                  metadata: (eb) => eb.ref("excluded.metadata"),
                  is_deleted: (eb) => eb.ref("excluded.is_deleted"),
                  updated_at: sql`${toSafeDateString(
                    patient.updated_at,
                  )}::timestamp with time zone`,
                  last_modified: sql`now()::timestamp with time zone`,
                })
                // Only update if the incoming record is newer than what's already stored
                .where(sql<boolean>`excluded.updated_at > patients.updated_at`),
            )
            .executeTakeFirst();
          // InsertResult is undefined when the updated_at guard skips a stale record
        } catch (error) {
          Logger.error({
            msg: "Patient upsert operation failed:",
            error: {
              operation: "patient_upsert",
              error: {
                message: error instanceof Error ? error.message : String(error),
                name:
                  error instanceof Error ? error.constructor.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
              },
              context: {
                patientId: patient.id,
              },
              timestamp: new Date().toISOString(),
            },
          });
          throw error;
        }
      },
    );

    /**
     * Soft Delete a patient record or multiple patient records without the additional patient attributes
     * DO NOT EXPORT OR USE THIS FUNCTION DIRECTLY
     */
    export const softDelete = createServerOnlyFn(
      async (id: string | string[]) => {
        // permissions check
        const clinicIds =
          await UserClinicPermissions.API.getClinicIdsWithPermissionFromToken(
            "can_delete_records",
          );

        const idArray = Array.isArray(id) ? id : [id];

        const patients = await db
          .selectFrom("patients")
          .where("id", "in", idArray)
          .select(["id", "primary_clinic_id"])
          .execute();

        if (patients.length === 0) {
          throw new Error("Patient(s) not found");
        }

        // Check authorization for all patients
        for (const patient of patients) {
          if (
            patient.primary_clinic_id &&
            !clinicIds.includes(patient.primary_clinic_id)
          ) {
            throw new Error(`Unauthorized to delete patient ${patient.id}`);
          }
        }

        return await softDelete_core(id);
      },
    );

    /**
     * ❌ DO NOT USE
     */
    export const DANGEROUS_SYNC_ONLY_softDelete = createServerOnlyFn(
      async (id: string) => {
        return softDelete_core(id);
      },
    );
    /**
     * Soft Delete a patient record without the additional patient attributes
     * DO NOT EXPORT OR USE THIS FUNCTION DIRECTLY
     */
    const softDelete_core = createServerOnlyFn(
      async (id: string | string[]) => {
        try {
          await db.transaction().execute(async (trx) => {
            await cascadeSoftDelete(trx, "patients", id);

            // Finally delete the patient record itself
            const idArray = Array.isArray(id) ? id : [id];
            await trx
              .updateTable(Patient.Table.name)
              // @ts-ignore
              .set({
                is_deleted: true,
                deleted_at: sql`now()::timestamp with time zone`,
                updated_at: sql`now()::timestamp with time zone`,
                last_modified: sql`now()::timestamp with time zone`,
              })
              .where("id", "in", idArray)
              .execute();
          });
        } catch (error) {
          const idArray = Array.isArray(id) ? id : [id];
          Logger.error({
            msg: "Patient soft delete operation failed:",
            error: {
              operation: "patient_soft_delete",
              error: {
                message: error instanceof Error ? error.message : String(error),
                name:
                  error instanceof Error ? error.constructor.name : "Unknown",
                stack: error instanceof Error ? error.stack : undefined,
              },
              context: {
                patientId: idArray,
              },
              timestamp: new Date().toISOString(),
            },
          });
          throw error;
        }
      },
    );

    export const DANGEROUSLY_GET_CLINIC_ID_BY_ID = createServerOnlyFn(
      async (id: string) => {
        const patient = await db
          .selectFrom("patients")
          .select("primary_clinic_id")
          .where("id", "=", id)
          .executeTakeFirst();
        return patient?.primary_clinic_id;
      },
    );
  }

  export const getPatientClinicId = createServerOnlyFn(async (id: string) => {
    const patient = await db
      .selectFrom("patients")
      .select("primary_clinic_id")
      .where("id", "=", id)
      .executeTakeFirst();
    return patient?.primary_clinic_id;
  });

  // export const ignorePatientRowFields = [
  //   "metadata",
  //   "deleted_at",
  //   "additional_attributes",
  //   "is_deleted",
  //   "last_modified",
  //   "photo_url",
  //   "server_created_at",
  //   "image_timestamp",
  //   "additional_data",
  // ];

  // const allIgnoredFields = [
  //   ...ignorePatientRowFields,
  //   "created_at",
  //   "updated_at",
  // ];

  export namespace Sync {
    export const upsertFromDelta = createServerOnlyFn(
      async (delta: Patient.EncodedT) => {
        // Returned so sync can tell an applied write from one the staleness
        // guard skipped; see Sync.classifyUpsertResult.
        return await API.DANGEROUS_SYNC_ONLY_upsert(delta);
      },
    );
    export const deleteFromDelta = createServerOnlyFn(async (id: string) => {
      await API.DANGEROUS_SYNC_ONLY_softDelete(id);
    });
  }
}

export default Patient;
