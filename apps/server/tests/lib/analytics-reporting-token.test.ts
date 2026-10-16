import { describe, it, expect } from "vitest";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  digestBody,
  signRequestToken,
  verifyPullToken,
} from "../../src/lib/analytics-reporting/token";

const segment = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    signingKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
    verifyingKey: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
  };
};

const backoffice = keyPair();
const REPORTER_ID = "6f1c2a7e-0b4d-4e2a-9a51-3f0f6d2c8b11";
const credentials = {
  client_verifying_key: backoffice.verifyingKey,
  reporter_id: REPORTER_ID,
};
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;
const BODY = '{"startDate":"2026-07-01","endDate":"2026-09-30"}';

// Mirrors the backoffice's signReportToken: exp = iat + 60, digest = sha256 hex of the body.
const pullToken = (
  overrides: {
    header?: object;
    claims?: Record<string, unknown>;
    body?: string;
    privateKey?: KeyObject;
  } = {},
) => {
  const header = segment(overrides.header ?? { alg: "EdDSA", typ: "JWT" });
  const claims = segment({
    sub: REPORTER_ID,
    iat: NOW_S,
    exp: NOW_S + 60,
    digest: createHash("sha256")
      .update(overrides.body ?? BODY)
      .digest("hex"),
    ...overrides.claims,
  });
  const signature = sign(
    null,
    Buffer.from(`${header}.${claims}`),
    overrides.privateKey ?? backoffice.privateKey,
  );
  return `${header}.${claims}.${signature.toString("base64url")}`;
};

describe("verifyPullToken", () => {
  it("accepts a pull signed by the backoffice for this body", () => {
    expect(verifyPullToken(pullToken(), BODY, credentials, NOW_MS)).toEqual({
      ok: true,
    });
  });

  it("rejects a tampered body", () => {
    const result = verifyPullToken(
      pullToken(),
      `${BODY} `,
      credentials,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "body digest mismatch" });
  });

  it("rejects a token signed with a different key", () => {
    const token = pullToken({ privateKey: keyPair().privateKey });
    const result = verifyPullToken(token, BODY, credentials, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects a token for another reporter", () => {
    const token = pullToken({ claims: { sub: "someone-else" } });
    const result = verifyPullToken(token, BODY, credentials, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "unexpected subject" });
  });

  it("allows 60s of skew past exp and no more", () => {
    const exp = NOW_S + 60;
    const at = (seconds: number) =>
      verifyPullToken(pullToken(), BODY, credentials, seconds * 1000);
    expect(at(exp + 60)).toEqual({ ok: true });
    expect(at(exp + 61)).toEqual({ ok: false, reason: "token expired" });
  });

  it("rejects a token issued more than 60s in the future", () => {
    const token = pullToken({ claims: { iat: NOW_S + 61, exp: NOW_S + 121 } });
    const result = verifyPullToken(token, BODY, credentials, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "token issued in the future" });
  });

  it("rejects a token without exp", () => {
    const token = pullToken({ claims: { exp: undefined } });
    const result = verifyPullToken(token, BODY, credentials, NOW_MS);
    expect(result).toEqual({ ok: false, reason: "missing exp" });
  });

  it.each([
    ["none", { alg: "none", typ: "JWT" }],
    ["RS256", { alg: "RS256", typ: "JWT" }],
    ["missing alg", { typ: "JWT" }],
  ])("rejects alg %s", (_label, header) => {
    const result = verifyPullToken(
      pullToken({ header }),
      BODY,
      credentials,
      NOW_MS,
    );
    expect(result).toEqual({ ok: false, reason: "unsupported algorithm" });
  });

  it("rejects an unsigned alg:none token", () => {
    const [header, claims] = pullToken({
      header: { alg: "none", typ: "JWT" },
    }).split(".");
    const result = verifyPullToken(
      `${header}.${claims}.`,
      BODY,
      credentials,
      NOW_MS,
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ["two parts", "a.b"],
    ["four parts", "a.b.c.d"],
    ["garbage segments", "!!!.@@@.###"],
  ])("rejects a malformed token (%s)", (_label, token) => {
    expect(verifyPullToken(token, BODY, credentials, NOW_MS).ok).toBe(false);
  });
});

describe("signRequestToken", () => {
  const ehr = keyPair();
  const ehrCredentials = {
    client_id: "api_abc123",
    client_signing_key: ehr.signingKey,
  };

  it("signs an EdDSA token for this client, verifiable with its public key", () => {
    const token = signRequestToken(ehrCredentials, BODY, NOW_MS + 999);
    const [header, claims, signature] = token.split(".");

    expect(decode(header)).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(decode(claims)).toEqual({
      sub: "api_abc123",
      iat: NOW_S,
      digest: createHash("sha256").update(BODY).digest("hex"),
    });
    const publicKey = createPublicKey({
      key: Buffer.from(ehr.verifyingKey, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  // The backoffice compares digest to sha256(body), so a bodiless request carries the hash of "".
  it("digests an empty body as sha256 of the empty string", () => {
    const claims = decode(
      signRequestToken(ehrCredentials, "", NOW_MS).split(".")[1],
    );
    expect(claims.digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(claims.digest).toBe(digestBody(""));
  });
});
