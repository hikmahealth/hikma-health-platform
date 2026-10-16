import { createServerOnlyFn } from "@tanstack/react-start";
import {
  deleteCredentials,
  readCredentials,
  saveCredentials,
  type ReportingCredentials,
} from "@/lib/analytics-reporting/credentials";
import { signRequestToken } from "@/lib/analytics-reporting/token";

const DEFAULT_HIKMA_REPORTER_URL = "https://api.hikmahealth.org";
const REQUEST_TIMEOUT_MS = 15_000;

// Read at call time from process.env: `@/env` only sees build-time values on the server.
const getHikmaReporterUrl = () =>
  process.env.HIKMA_REPORTER_URL || DEFAULT_HIKMA_REPORTER_URL;

type ReporterRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  credentials?: ReportingCredentials;
  body?: unknown;
};

// Serialized once so the signed digest covers the exact bytes sent.
async function reporterFetch({
  method,
  path,
  credentials,
  body,
}: ReporterRequest): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (credentials) {
    headers.Authorization = `Bearer ${signRequestToken(credentials, text)}`;
  }
  return fetch(new URL(path, getHikmaReporterUrl()), {
    method,
    headers,
    body: body === undefined ? undefined : text,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const getReportUrl = () => {
  const appUrl = process.env.SERVER_URL || process.env.RENDER_EXTERNAL_URL;
  if (!appUrl) {
    throw new Error(
      "SERVER_URL is not configured; the reporting service needs it to reach this instance",
    );
  }
  return new URL("/api/hh/analytics/report", appUrl).href;
};

const registerErrorMessage = (status: number) => {
  if (status === 400) return "Reporting service rejected the organization details";
  if (status === 503) {
    return "Reporting service registrations are paused; try again later";
  }
  return `Reporting service rejected registration (status ${status})`;
};

const detailsErrorMessage = (status: number) => {
  if (status === 400) {
    return "Reporting service rejected the report URL; it must be https and publicly reachable";
  }
  if (status === 409) {
    return "This report URL is already registered, or belongs to another verified deployment";
  }
  return `Reporting service rejected the report details (status ${status})`;
};

async function putReportDetails(credentials: ReportingCredentials) {
  const response = await reporterFetch({
    method: "PUT",
    path: "/v1/ehr-reporting/details",
    credentials,
    body: { report_url: getReportUrl() },
  });
  if (!response.ok) throw new Error(detailsErrorMessage(response.status));
}

export type RegistrationResult =
  | { ok: true; detailsSubmitted: true }
  | { ok: true; detailsSubmitted: false; detailsError: string };

/** Registers, saves the credentials, then sends the report URL; if that last step fails, retry it with `submitReportDetails`. */
export const registerWithReportingService = createServerOnlyFn(
  async (organization_name: string): Promise<RegistrationResult> => {
    const response = await reporterFetch({
      method: "POST",
      path: "/v1/ehr-reporting/register",
      body: { organization_name },
    });
    if (response.status !== 201) {
      throw new Error(registerErrorMessage(response.status));
    }

    const body = (await response.json()) as {
      ok?: boolean;
      credentials?: ReportingCredentials;
    };
    if (!body.ok || !body.credentials) {
      throw new Error("Reporting service returned no credentials");
    }
    // The signing key is only returned once: save it before anything else can fail.
    await saveCredentials(body.credentials);

    try {
      await putReportDetails(body.credentials);
      return { ok: true, detailsSubmitted: true };
    } catch (error) {
      return {
        ok: true,
        detailsSubmitted: false,
        detailsError:
          error instanceof Error ? error.message : "Failed to send report details",
      };
    }
  },
);

/** Re-sends the report URL for a registered instance. */
export const submitReportDetails = createServerOnlyFn(async () => {
  const credentials = await readCredentials();
  if (!credentials) {
    throw new Error("This instance is not registered with the reporting service");
  }
  await putReportDetails(credentials);
  return { ok: true as const };
});

export type ReportingState =
  | "registered"
  | "pending_verification"
  | "unregistered"
  | "forbidden"
  | "unreachable";

export type ReportingStatus = {
  state: ReportingState;
  /** `null` until the report URL has been sent */
  reportUrl: string | null;
};

const unregistered: ReportingStatus = { state: "unregistered", reportUrl: null };

export const getReportingStatus = createServerOnlyFn(
  async (): Promise<ReportingStatus> => {
    const credentials = await readCredentials();
    if (!credentials) return unregistered;

    try {
      const response = await reporterFetch({
        method: "GET",
        path: "/v1/ehr-reporting/registration",
        credentials,
      });
      if (response.status === 401) return unregistered;
      if (response.status === 404) return unregistered;
      if (response.status === 403) return { state: "forbidden", reportUrl: null };
      if (response.status !== 200) return { state: "unreachable", reportUrl: null };

      const body = (await response.json()) as {
        data?: { verification_status?: string; report_url?: string | null };
      };
      const reportUrl = body.data?.report_url ?? null;
      if (body.data?.verification_status === "verified") {
        return { state: "registered", reportUrl };
      }
      if (body.data?.verification_status === "unverified") {
        return { state: "pending_verification", reportUrl };
      }
      return { state: "unreachable", reportUrl: null };
    } catch (error) {
      console.error("Failed to fetch reporting status:", error);
      return { state: "unreachable", reportUrl: null };
    }
  },
);

/** Disconnects and removes local credentials; a rejected organization (403) can't disconnect, so they're kept. */
export const unregisterFromReportingService = createServerOnlyFn(async () => {
  const credentials = await readCredentials();
  if (!credentials) return { ok: true as const };

  const response = await reporterFetch({
    method: "DELETE",
    path: "/v1/ehr-reporting/registration",
    credentials,
  });

  if (response.status === 403) {
    throw new Error(
      "The reporting service rejected this organization; it can't disconnect itself",
    );
  }
  // 401 and 404 mean the service no longer recognises these credentials
  const cleared =
    response.ok || response.status === 401 || response.status === 404;
  if (!cleared) {
    throw new Error(
      `Reporting service rejected disconnect (status ${response.status})`,
    );
  }

  await deleteCredentials();
  return { ok: true as const };
});
