import db, { pool } from "@/db";
import { validateSQL } from "@/db/utils";
import { superAdminMiddleware } from "@/middleware/auth";
import Report from "@/models/report";
import { Logger } from "@hikmahealth/js-utils";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "kysely";

/**
 * Fetch a single report with its components by ID.
 */
export const getReport = createServerFn({ method: "GET" })
	.validator((data: { id: string }) => data)
	.middleware([superAdminMiddleware])
	.handler(async ({ data }) => {
		return await Report.API.getById(data.id);
	});

/**
 * Upsert a report and its components.
 */
export const saveReport = createServerFn({ method: "POST" })
	.validator(
		(data: { report: Parameters<typeof Report.API.update>[0] }) => data,
	)
	.middleware([superAdminMiddleware])
	.handler(async ({ data }) => {
		return await Report.API.update(data.report);
	});

/**
 * Soft delete a report and its components by ID.
 */
export const deleteReport = createServerFn({ method: "POST" })
	.validator((data: { id: string }) => data)
	.middleware([superAdminMiddleware])
	.handler(async ({ data }) => {
		await Report.API.softDelete(data.id);
	});

/**
 * Validate and update the compiled SQL of a single report component.
 * Uses PREPARE/DEALLOCATE to validate syntax and schema before persisting.
 */
export const updateComponentSql = createServerFn({ method: "POST" })
	.validator((data: { componentId: string; compiledSql: string }) => data)
	.middleware([superAdminMiddleware])
	.handler(async ({ data }) => {
		const { componentId, compiledSql } = data;
		Logger.log({
			msg: "[updateComponentSql] called",
			data: {
				componentId,
				sqlLength: compiledSql.length,
			},
		});

		Logger.log({ msg: "[updateComponentSql] validating SQL..." });
		const validation = await validateSQL(pool, compiledSql);
		Logger.log({ msg: "[updateComponentSql] validation result:", validation });
		if (!validation.valid) {
			Logger.error({
				msg: "[updateComponentSql] invalid SQL:",
				error: validation.error,
			});
			return Promise.reject({
				message: `Invalid SQL: ${validation.error}`,
				source: "updateComponentSql",
			});
		}

		// SQL is valid — persist the update
		Logger.log({
			msg: "[updateComponentSql] persisting update for component:",
			componentId,
		});
		const result = await db
			.updateTable("report_components")
			.set({
				compiled_sql: compiledSql,
				updated_at: sql`now()::timestamp with time zone`,
				last_modified: sql`now()::timestamp with time zone`,
			})
			.where("id", "=", componentId)
			.where("is_deleted", "=", false)
			.executeTakeFirst();

		Logger.log({ msg: "[updateComponentSql] update result:", result });
		Logger.log("[updateComponentSql] done");
		return { componentId, compiledSql };
	});
