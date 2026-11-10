/**
 * Reaction to HERS `environment.anomaly_detected` webhook events: pick the
 * patients most relevant to the anomaly and ask HERS to classify their
 * environmental health risk.
 */

import type {
	AnomalyDetectedEvent,
	ClassifyPatient,
	ClassifyResponse,
	Sex,
} from "@hikmahealth/hers";
import { Logger } from "@hikmahealth/js-utils";
import { differenceInCalendarDays } from "date-fns";
import db from "@/db";
import Patient from "@/models/patient";
import { getHersClient, hersRequestOptions } from "./store";

/** Patients sent per classify request. */
const CLASSIFY_BATCH_SIZE = 100;
/** Cap on patients considered per anomaly until real relevance logic exists. */
const STUB_PATIENT_LIMIT = 500;

type AnomalyContext = {
	/** Clinic id; we register clinics with HERS using their id as location key. */
	clinicId: string;
	event: AnomalyDetectedEvent;
};

const toSex = (value: string | null): Sex | null => {
	const v = value?.trim().toLowerCase();
	if (!v) return null;
	if (v === "male" || v === "m") return "male";
	if (v === "female" || v === "f") return "female";
	return null;
};

/**
 * STUB: decides which patients an anomaly is relevant to.
 *
 * For now this is every active patient whose primary clinic is the affected
 * clinic, capped at {@link STUB_PATIENT_LIMIT}. Replace with real relevance
 * logic (e.g. recent visits, conditions sensitive to the anomaly's feature,
 * distance from the location) before relying on the results.
 */
export async function findRelevantPatients({
	clinicId,
}: AnomalyContext): Promise<ClassifyPatient[]> {
	const rows = await db
		.selectFrom(Patient.Table.name)
		.select(["id", "sex", "date_of_birth"])
		.where("primary_clinic_id", "=", clinicId)
		.where("is_deleted", "=", false)
		.limit(STUB_PATIENT_LIMIT)
		.execute();

	const today = new Date();
	return rows.map((row) => ({
		id: row.id,
		sex: toSex(row.sex),
		age_in_days: row.date_of_birth
			? Math.max(0, differenceInCalendarDays(today, row.date_of_birth))
			: null,
	}));
}

/**
 * STUB: what to do with the classification results. Only logs aggregate
 * counts for now (no patient identifiers), until there is somewhere to surface
 * them (alerts, a patient flag, a report...).
 */
async function onClassificationResults(
	{ clinicId, event }: AnomalyContext,
	results: ClassifyResponse,
): Promise<void> {
	const counts: Record<string, number> = {};
	for (const { result } of results) {
		const bucket = result ? `${result.type}:${result.score}` : "undetermined";
		counts[bucket] = (counts[bucket] ?? 0) + 1;
	}
	Logger.log({
		msg: "HERS classification completed",
		clinicId,
		configurationId: event.data.configuration_id,
		features: event.data.anomalies.map((a) => a.feature),
		patients: results.length,
		counts,
	});
}

export async function handleAnomalyDetected(
	event: AnomalyDetectedEvent,
): Promise<void> {
	const clinicId = event.data.location.reference;
	if (!clinicId) {
		Logger.log({
			msg: "HERS anomaly for a location without a reference; ignoring",
			locationId: event.data.location.id,
		});
		return;
	}

	const context: AnomalyContext = { clinicId, event };
	const patients = await findRelevantPatients(context);
	if (patients.length === 0) {
		Logger.log({ msg: "HERS anomaly: no relevant patients", clinicId });
		return;
	}

	const hers = await getHersClient();
	const results: ClassifyResponse = [];
	for (let i = 0; i < patients.length; i += CLASSIFY_BATCH_SIZE) {
		const batch = patients.slice(i, i + CLASSIFY_BATCH_SIZE);
		results.push(
			...(await hers.hers.classify(clinicId, batch, hersRequestOptions())),
		);
	}

	await onClassificationResults(context, results);
}
