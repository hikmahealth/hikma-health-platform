import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import Appointment from "@/models/appointment";
import User from "@/models/user";
import {
  constructLayoutConfig,
  constructReport,
  constructReportComponent,
  fixedRange,
  type report as Report,
  type reportComponent,
  type componentDisplay,
  type gridPosition,
  type timeRange,
} from "./report.gen";
import PatientRegistrationForm from "@/models/patient-registration-form";
import EventForm from "@/models/event-form";
import PatientVital from "@/models/patient-vital";
import PatientProblem from "@/models/patient-problem";
import Patient from "@/models/patient";
import PatientAdditionalAttribute from "@/models/patient-additional-attribute";
import {
  isUserSuperAdmin,
  getCurrentUserId,
  userRoleTokenHasCapability,
} from "../auth/request";
import ReportModel from "@/models/report";
import db from "@/db";
import Event from "@/models/event";
import Visit from "@/models/visit";
import Clinic from "@/models/clinic";
import { uuidv7 } from "uuidv7";
import type { TableMeta } from "@tanstack/react-table";
import { z } from "zod";
import { sql, type TableMetadata } from "kysely";
import { adminMiddleware } from "@/middleware/auth";

// AI RESPONSE TYPES — snake_case, as the AI service sends them

type AIDisplayConfig = {
  type: string;
  config: Record<string, unknown>;
};

type AIReportComponent = {
  title: string;
  description?: string;
  prql_source: string;
  compiled_sql: string;
  compile_error: string | null;
  display: AIDisplayConfig;
  position: { x: number; y: number; w: number; h: number };
};

// PARSING

const parseFormat = (f: unknown) => {
  if (f === "number") return "Number" as const;
  if (f === "currency") return "Currency" as const;
  if (f === "percent") return "Percent" as const;
  return undefined;
};

const parseTableFormat = (f: unknown) => {
  const base = parseFormat(f);
  if (base) return base;
  if (f === "date") return "Date" as const;
  return undefined;
};

const parseOrientation = (o: unknown) => {
  if (o === "horizontal") return "Horizontal" as const;
  if (o === "vertical") return "Vertical" as const;
  return undefined;
};

const parseSortDir = (d: unknown) => {
  if (d === "asc") return "Asc" as const;
  if (d === "desc") return "Desc" as const;
  return undefined;
};

export const parseDisplayType = (
  display: AIDisplayConfig,
): componentDisplay | null => {
  const { type, config } = display;

  switch (type) {
    case "stat_card":
      return {
        TAG: "StatCard",
        _0: {
          valueField: config.value_field as string,
          label: config.label as string,
          ...(config.format != null && { format: parseFormat(config.format) }),
          ...(config.comparison_field != null && {
            comparisonField: config.comparison_field as string,
          }),
        },
      };

    case "table":
      return {
        TAG: "Table",
        _0: {
          columns: (config.columns as any[]).map((col) => ({
            key: col.key as string,
            label: col.label as string,
            ...(col.format != null && { format: parseTableFormat(col.format) }),
            ...(col.sortable != null && { sortable: col.sortable as boolean }),
          })),
        },
      };

    case "line_chart":
      return {
        TAG: "LineChart",
        _0: {
          xAxis: config.x_axis as string,
          yAxis: config.y_axis as string,
          ...(config.series_field != null && {
            seriesField: config.series_field as string,
          }),
        },
      };

    case "pie_chart":
      return {
        TAG: "PieChart",
        _0: {
          labelField: config.label_field as string,
          valueField: config.value_field as string,
        },
      };

    case "bar_chart":
      return {
        TAG: "BarChart",
        _0: {
          xAxis: config.x_axis as string,
          yAxis: config.y_axis as string,
          ...(config.orientation != null && {
            orientation: parseOrientation(config.orientation),
          }),
          ...(config.stacked != null && { stacked: config.stacked as boolean }),
          ...(config.sort_by != null && { sortBy: config.sort_by as string }),
          ...(config.sort_dir != null && {
            sortDir: parseSortDir(config.sort_dir),
          }),
        },
      };

    default:
      return null;
  }
};

export const parseAIReportComponent = (
  raw: AIReportComponent,
  reportId: string,
): reportComponent | null => {
  if (raw.compile_error) return null;

  const display = parseDisplayType(raw.display);
  if (!display) return null;

  return {
    id: uuidv7(),
    reportId,
    title: raw.title,
    ...(raw.description != null && { description: raw.description }),
    prqlSource: raw.prql_source,
    compiledSql: raw.compiled_sql,
    compiledAt: new Date().toISOString(),
    compilerVersion: "0.1.0",
    position: raw.position,
    display,
  };
};

export const parseAIResponse = (
  components: AIReportComponent[],
  reportId: string,
): reportComponent[] =>
  components.reduce<reportComponent[]>((acc, raw) => {
    const parsed = parseAIReportComponent(raw, reportId);
    return parsed ? [...acc, parsed] : acc;
  }, []);

// SQL EXECUTION

// Patterns that should never appear in compiled SQL.
const DANGEROUS_SQL_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE)\b/i,
  /\b(GRANT|REVOKE|COMMIT|ROLLBACK|SAVEPOINT)\b/i,
  /\b(EXEC|EXECUTE|CALL)\b/i,
  /\b(ATTACH|DETACH)\b/i,
  /\b(PRAGMA)\b/i,
  /\b(VACUUM|REINDEX|ANALYZE)\b/i,
  /;\s*\S/, // multiple statements
];

export type ComponentData = {
  componentId: string;
  rows: Record<string, unknown>[];
  error: string | null;
};

const validateCompiledSql = (compiledSql: string): void => {
  for (const pattern of DANGEROUS_SQL_PATTERNS) {
    if (pattern.test(compiledSql)) {
      throw new Error(
        `Compiled SQL rejected: matches forbidden pattern ${pattern}`,
      );
    }
  }
};

const executeComponentQuery = async (
  compiledSql: string,
  startAt: string,
  endAt: string,
): Promise<Record<string, unknown>[]> => {
  validateCompiledSql(compiledSql);

  const rows = await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    // Replace $1/$2 placeholders with Kysely-managed parameter bindings
    const parts = compiledSql.split(/\$[12]/);
    const params = [startAt, endAt];
    const bound = parts.reduce<ReturnType<typeof sql<Record<string, unknown>>>>(
      (acc, part, i) => {
        if (i === 0) return sql<Record<string, unknown>>`${sql.raw(part)}`;
        return sql<
          Record<string, unknown>
        >`${acc}${params[i - 1]}${sql.raw(part)}`;
      },
      sql``,
    );
    const result = await bound.execute(trx);
    return result.rows;
  });
  return rows;
};

const fetchAllComponentDataInternal = async (
  components: reportComponent[],
  startAt: string,
  endAt: string,
): Promise<ComponentData[]> =>
  Promise.all(
    components.map(async (c) => {
      try {
        const rows = await executeComponentQuery(c.compiledSql, startAt, endAt);
        return { componentId: c.id, rows, error: null };
      } catch (err: any) {
        Logger.error({
          msg: "[Report] Error fetching component of report: ",
          err,
        });
        return {
          componentId: c.id,
          rows: [],
          error: err?.message ?? "Query failed",
        };
      }
    }),
  );

export const fetchAllComponentData = createServerFn({ method: "POST" })
  .validator(
    (data: { components: reportComponent[]; startAt: string; endAt: string }) =>
      data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }): Promise<ComponentData[]> => {
    return fetchAllComponentDataInternal(
      data.components,
      data.startAt,
      data.endAt,
    );
  });

export type ReportWithData = {
  report: Report;
  data: ComponentData[];
};

// TABLES THE REPORTING QUERIES MAY READ
const INCLUDED_TABLES = [
  PatientAdditionalAttribute.Table.name,
  Patient.Table.name,
  PatientVital.Table.name,
  PatientProblem.Table.name,
  PatientRegistrationForm.Table.name,
  Event.Table.name,
  Visit.Table.name,
  User.Table.name,
  Clinic.Table.name,
];

import ServerVariable from "@/models/server_variable";
import { Result } from "../result";
import { match } from "ts-pattern";
import { Logger } from "@hikmahealth/js-utils";

type ManagerReportRequest = {
  user_prompt: string;
  patient_registration_form: Record<string, unknown>;
  event_forms: any[];
  db_schema: TableMetadata[];
  report?: Record<string, unknown>;
  ai_api_key: string;
};

// SHARED INPUT TYPE FOR REPORT ENDPOINTS

export type ReportInput = {
  report_id?: string;
  user_description: string;
  name: string;
  description?: string;
  time_range: timeRange;
};

export type component_request = {
  user_prompt: string;
  patient_registration_form: ManagerReportRequest["patient_registration_form"];
  event_forms: ManagerReportRequest["event_forms"];
  db_schema: ManagerReportRequest["db_schema"];
  ai_api_key?: string;
  /** When present, the LLM edits this component. When absent, it creates from scratch. */
  component?: {
    title: string;
    description: string;
    prql_source: string;
    display: any;
    position: any;
  };
};

// PROMPT REFINEMENT RESPONSE SCHEMA

const prompt_suggestion_schema = z.object({
  refined_prompt: z.string(),
  reasoning: z.string(),
});

export const prompt_refine_response_schema = z.object({
  suggestions: z.array(prompt_suggestion_schema).length(3),
});

export const refineReportPrompt = createServerFn({ method: "POST" })
  .validator((data: ReportInput) => data)
  .handler(
    async ({
      data,
    }): Promise<z.infer<typeof prompt_refine_response_schema>> => {
      // TODO: replace with only super_admin permission role
      const authorized = await isUserSuperAdmin();

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "refineReportPrompt",
        });
      }

      const dbInfo = await getAIReportingInfo();
      if (Result.isErr(dbInfo)) {
        return Promise.reject(dbInfo.error);
      }

      const {
        event_forms,
        patient_registration_forms,
        tables,
        aiServiceUrl,
        anthropicApiKey,
        aiProxyApiKey,
      } = dbInfo.data;

      const reportId = data.report_id ?? uuidv7();
      const layout = constructLayoutConfig(12);
      const reportComponents: reportComponent[] = [];

      const initialReport = constructReport(
        reportId,
        data.name,
        data.description ?? "",
        data.time_range,
        layout,
        reportComponents,
      );

      if (!aiServiceUrl) {
        return Promise.reject({
          message: "AI service URL is not configured",
          source: "refineReportPrompt",
        });
      }
      if (!anthropicApiKey) {
        return Promise.reject({
          message: "Anthropic API key is not configured",
          source: "refineReportPrompt",
        });
      }

      if (!aiProxyApiKey) {
        return Promise.reject({
          message: "AI Proxy API key is not configured",
          source: "refineReportPrompt",
        });
      }

      const aiRequest: ManagerReportRequest = {
        user_prompt: data.user_description,
        db_schema: tables,
        event_forms,
        patient_registration_form: patient_registration_forms[0],
        report: initialReport,
        ai_api_key: anthropicApiKey,
      };

      const res = await fetch(`${aiServiceUrl}/reports/prompt-refine`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": aiProxyApiKey,
        },
        body: JSON.stringify(aiRequest),
      });

      const data_ = await res.json();
      return data_;
    },
  );

/** Update (or create) a report using the hh ai service. */
export const editReport = createServerFn({ method: "POST" })
  .validator((data: component_request) => data)
  .handler(
    async ({ data }): Promise<{ status: "ok"; component: reportComponent }> => {
      // TODO: replace with only super_admin permission role
      const authorized = await isUserSuperAdmin();

      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "editReport",
        });
      }

      const dbInfo = await getAIReportingInfo();
      if (Result.isErr(dbInfo)) {
        return Promise.reject(dbInfo.error);
      }

      const {
        event_forms,
        patient_registration_forms,
        tables,
        aiServiceUrl,
        anthropicApiKey,
        aiProxyApiKey,
      } = dbInfo.data;

      const reportId = data.report_id ?? uuidv7();
      const layout = constructLayoutConfig(12);
      const reportComponents: reportComponent[] = [];

      const initialReport = constructReport(
        reportId,
        data.name,
        data.description ?? "",
        data.time_range,
        layout,
        reportComponents,
      );

      if (!aiServiceUrl) {
        return Promise.reject({
          message: "AI service URL is not configured",
          source: "editReport",
        });
      }
      if (!anthropicApiKey) {
        return Promise.reject({
          message: "Anthropic API key is not configured",
          source: "editReport",
        });
      }
      if (!aiProxyApiKey) {
        return Promise.reject({
          message: "AI Proxy API key is not configured",
          source: "refineReportPrompt",
        });
      }

      const aiRequest: ManagerReportRequest = {
        user_prompt: data.user_description,
        db_schema: tables,
        event_forms,
        patient_registration_form: patient_registration_forms[0],
        report: initialReport,
        ai_api_key: anthropicApiKey,
      };

      const res = await fetch(`${aiServiceUrl}/reports/manage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": aiProxyApiKey,
        },
        body: JSON.stringify(aiRequest),
      });

      if (!res.ok) {
        return Promise.reject({
          message: `AI service error: ${res.status}`,
          source: "editReport",
        });
      }

      const aiResponse = await res.json();
      const aiComponents: AIReportComponent[] = Array.isArray(aiResponse)
        ? aiResponse
        : (aiResponse.components ?? []);
      const parsedComponents = parseAIResponse(aiComponents, reportId);

      const report = constructReport(
        reportId,
        data.name,
        data.description ?? "",
        data.time_range,
        layout,
        parsedComponents,
      );

      const userId = await getCurrentUserId();
      const savedReport = await ReportModel.API.update({
        report,
        clinicId: null,
        createdBy: userId,
      });

      const { startAt, endAt } = ReportModel.resolveTimeRange(data.time_range);
      const data_ = await fetchAllComponentDataInternal(
        parsedComponents,
        startAt,
        endAt,
      );
      return { report: savedReport, data: data_ };
    },
  );

/**
 * Update (or create) a single report component via POST /reports/update-component,
 * sending the existing component as context.
 */
export const editReportComponent = createServerFn({ method: "POST" })
  .validator(
    (data: {
      report_id: string;
      user_prompt: string;
      component: {
        title: string;
        description: string;
        prql_source: string;
        display: any;
        position: any;
      };
    }) => data,
  )
  .handler(async ({ data }): Promise<reportComponent> => {
    const authorized = await isUserSuperAdmin();
    if (!authorized) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "editReportComponent",
      });
    }

    Logger.log("[editReportComponent]");
    Logger.log(data);

    const dbInfo = await getAIReportingInfo();
    if (Result.isErr(dbInfo)) {
      return Promise.reject(dbInfo.error);
    }

    const {
      event_forms,
      patient_registration_forms,
      tables,
      aiServiceUrl,
      anthropicApiKey,
      aiProxyApiKey,
    } = dbInfo.data;

    if (!aiServiceUrl) {
      return Promise.reject({
        message: "AI service URL is not configured",
        source: "editReportComponent",
      });
    }
    if (!anthropicApiKey) {
      return Promise.reject({
        message: "Anthropic API key is not configured",
        source: "editReportComponent",
      });
    }
    if (!aiProxyApiKey) {
      return Promise.reject({
        message: "AI Proxy API key is not configured",
        source: "editReportComponent",
      });
    }

    const aiRequest: component_request = {
      user_prompt: data.user_prompt,
      db_schema: tables,
      event_forms,
      patient_registration_form: patient_registration_forms[0],
      ai_api_key: anthropicApiKey,
      component: data.component,
    };

    const res = await fetch(`${aiServiceUrl}/reports/update-component`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": aiProxyApiKey,
      },
      body: JSON.stringify(aiRequest),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return Promise.reject({
        message: `AI service error: ${res.status}${body ? ` — ${body}` : ""}`,
        source: "editReportComponent",
      });
    }

    const aiResponse: { status: "ok" | string; component?: AIReportComponent } =
      await res.json();
    const parsed = aiResponse.component
      ? parseAIReportComponent(aiResponse.component, data.report_id)
      : null;

    if (!parsed) {
      return Promise.reject({
        message: "Failed to parse AI response into a valid component",
        source: "editReportComponent",
      });
    }

    return parsed;
  });

/** Schema and sample data the AI service needs to author a report. */
const getAIReportingInfo = createServerFn().handler(async () => {
  const isAdmin = await isUserSuperAdmin();
  if (!isAdmin) {
    return Result.err({
      _tag: "Unauthorized",
      message: "Only system administrators are allowed to use this method",
    });
  }
  const patient_registration_forms = await PatientRegistrationForm.getAll(); // need to eventually pick just one
  const event_forms = await EventForm.API.getAll();

  const tables = (
    await db.introspection.getTables({
      withInternalKyselyTables: false,
    })
  ).filter((table) => INCLUDED_TABLES.includes(table.name));

  const [aiServiceUrl, anthropicApiKey, aiProxyApiKey] = await Promise.all([
    ServerVariable.getAsString(ServerVariable.Keys.AI_DATA_ANALYSIS_URL),
    ServerVariable.getAsString(ServerVariable.Keys.ANTHROPIC_API_KEY),
    ServerVariable.getAsString(ServerVariable.Keys.AI_PROXY_SERVICE_API_KEY),
  ]);

  return Result.ok({
    tables,
    patient_registration_forms,
    event_forms,
    aiServiceUrl,
    anthropicApiKey,
    aiProxyApiKey,
  });
});
