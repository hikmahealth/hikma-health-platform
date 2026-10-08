import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { z } from "zod";
import { superAdminMiddleware } from "@/middleware/auth";
import {
  deleteCredentials,
  readCredentials,
  saveCredentials,
} from "@/lib/analytics-reporting/credentials";

// Registers this instance with the reporting service and saves the issued credentials
export const registerWithReportingService = createServerOnlyFn(
  async (organization_name: string) => {
    if (!process.env.HIKMA_REPORTER_URL) {
      throw new Error("HIKMA_REPORTER_URL is not configured on this instance");
    }
    if (!process.env.SERVER_URL) {
      throw new Error(
        "SERVER_URL is not configured; the reporting service needs it to reach this instance",
      );
    }

    const response = await fetch(
      new URL("/api/report/register", process.env.HIKMA_REPORTER_URL),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_name,
          report_url: new URL(
            "/api/hh/analytics/report",
            process.env.SERVER_URL,
          ).href,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Reporting service rejected registration (status ${response.status})`,
      );
    }

    const body = (await response.json()) as {
      ok: boolean;
      credentials?: {
        client_id: string; // passed as the `Hikma-Health-Requester` header
        client_verifying_key: string; // used as part of the authorization
        version: string;
      };
    };

    if (!body.ok || !body.credentials) {
      throw new Error("Reporting service returned no credentials");
    }

    await saveCredentials(body.credentials);
    return { ok: true as const };
  },
);

// Unregisters this instance from the reporting service and removes local credentials
export const unregisterFromReportingService = createServerOnlyFn(async () => {
  if (!process.env.HIKMA_REPORTER_URL) {
    throw new Error("HIKMA_REPORTER_URL is not configured on this instance");
  }

  const credentials = await readCredentials();
  if (!credentials) {
    // nothing to unregister locally
    return { ok: true as const };
  }

  const response = await fetch(
    new URL("/api/report", process.env.HIKMA_REPORTER_URL),
    {
      method: "DELETE",
      headers: {
        "Hikma-Health-Requester": credentials.client_id,
      },
    },
  );

  // 404 means the service already doesn't know us, so we can safely clean up
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Reporting service rejected unsubscribe (status ${response.status})`,
    );
  }

  await deleteCredentials();
  return { ok: true as const };
});
