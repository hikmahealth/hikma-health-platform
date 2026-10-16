import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: <T>(fn: T) => fn,
}));

const store = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
}));
vi.mock("@/lib/analytics-reporting/credentials", () => store);

import {
  getReportingStatus,
  registerWithReportingService,
  unregisterFromReportingService,
} from "../../src/action/register.reporter";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const CREDENTIALS = {
  client_id: "api_abc123",
  client_signing_key: privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64url"),
  client_verifying_key: publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64url"),
  reporter_id: "6f1c2a7e-0b4d-4e2a-9a51-3f0f6d2c8b11",
  version: 1,
};

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const fetchMock = vi.fn<typeof fetch>();
const calls: string[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("SERVER_URL", "https://ehr.example.org");
  vi.stubEnv("HIKMA_REPORTER_URL", "");
  fetchMock.mockReset();
  calls.length = 0;
  store.readCredentials.mockReset().mockResolvedValue(CREDENTIALS);
  store.saveCredentials.mockReset().mockImplementation(async () => {
    calls.push("save");
  });
  store.deleteCredentials.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("getReportingStatus", () => {
  it.each([
    [
      json(200, {
        data: {
          verification_status: "verified",
          report_url: "https://ehr.example.org/api/hh/analytics/report",
        },
      }),
      {
        state: "registered",
        reportUrl: "https://ehr.example.org/api/hh/analytics/report",
      },
    ],
    [
      json(200, {
        data: { verification_status: "unverified", report_url: null },
      }),
      { state: "pending_verification", reportUrl: null },
    ],
    [json(401), { state: "unregistered", reportUrl: null }],
    [json(404), { state: "unregistered", reportUrl: null }],
    [
      json(403, { data: { verification_status: "rejected" } }),
      { state: "forbidden", reportUrl: null },
    ],
    [json(500), { state: "unreachable", reportUrl: null }],
  ])("maps response %# to its state", async (response, expected) => {
    fetchMock.mockResolvedValueOnce(response);
    expect(await getReportingStatus()).toEqual(expected);
  });

  it("reports unreachable when the request fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await getReportingStatus()).toEqual({
      state: "unreachable",
      reportUrl: null,
    });
  });

  it("is unregistered without calling the service when no credentials are stored", async () => {
    store.readCredentials.mockResolvedValue(null);
    expect(await getReportingStatus()).toEqual({
      state: "unregistered",
      reportUrl: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a signed GET to the registration endpoint", async () => {
    fetchMock.mockResolvedValueOnce(json(404));
    await getReportingStatus();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.hikmahealth.org/v1/ehr-reporting/registration",
    );
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer /);
  });
});

describe("unregisterFromReportingService", () => {
  it.each([200, 401, 404])("clears local credentials on %i", async (status) => {
    fetchMock.mockResolvedValueOnce(json(status));
    await expect(unregisterFromReportingService()).resolves.toEqual({
      ok: true,
    });
    expect(store.deleteCredentials).toHaveBeenCalledOnce();
  });

  it("keeps credentials when the organization was rejected (403)", async () => {
    fetchMock.mockResolvedValueOnce(json(403));
    await expect(unregisterFromReportingService()).rejects.toThrow(
      /rejected this organization/,
    );
    expect(store.deleteCredentials).not.toHaveBeenCalled();
  });
});

describe("registerWithReportingService", () => {
  const registered = () => json(201, { ok: true, credentials: CREDENTIALS });

  it("saves credentials before sending details, and signs the exact bytes sent", async () => {
    fetchMock
      .mockResolvedValueOnce(registered())
      .mockImplementationOnce(async () => {
        calls.push("details");
        return json(200, { ok: true });
      });

    await expect(registerWithReportingService("Clinic A")).resolves.toEqual({
      ok: true,
      detailsSubmitted: true,
    });
    expect(calls).toEqual(["save", "details"]);

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe(
      "https://api.hikmahealth.org/v1/ehr-reporting/details",
    );
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      report_url: "https://ehr.example.org/api/hh/analytics/report",
    });
    const token = new Headers(init?.headers)
      .get("Authorization")!
      .slice("Bearer ".length);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(claims.digest).toBe(
      createHash("sha256").update(String(init?.body)).digest("hex"),
    );
  });

  it("keeps credentials and reports the error when the details step fails", async () => {
    fetchMock
      .mockResolvedValueOnce(registered())
      .mockResolvedValueOnce(json(409));

    const result = await registerWithReportingService("Clinic A");
    expect(result).toEqual({
      ok: true,
      detailsSubmitted: false,
      detailsError: expect.stringMatching(/already registered/),
    });
    expect(store.saveCredentials).toHaveBeenCalledWith(CREDENTIALS);
    expect(store.deleteCredentials).not.toHaveBeenCalled();
  });

  it.each([400, 503, 200])(
    "throws and saves nothing when register returns %i",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        json(status, { ok: true, credentials: CREDENTIALS }),
      );
      await expect(registerWithReportingService("Clinic A")).rejects.toThrow();
      expect(store.saveCredentials).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("registers unauthenticated with only the organization name", async () => {
    fetchMock
      .mockResolvedValueOnce(registered())
      .mockResolvedValueOnce(json(200));
    await registerWithReportingService("Clinic A");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      "https://api.hikmahealth.org/v1/ehr-reporting/register",
    );
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      organization_name: "Clinic A",
    });
  });
});
