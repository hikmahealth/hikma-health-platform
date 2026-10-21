// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPasswordLength } from "@/lib/setup/password-policy";
import { checkPassword, isCommonPassword } from "@/lib/setup/common-passwords";

const LIST_PATH = resolve(
  __dirname,
  "../../src/lib/setup/common-passwords.txt",
);
const LIST_SHA256 =
  "83cab4e1a15eef1ecb2bc5bde7d2c80be0d780cfe58a62b6aef49faecfa6c5f5";

describe("common-passwords.txt", () => {
  const content = readFileSync(LIST_PATH);
  const entries = content.toString("utf8").split("\n").filter(Boolean);

  it("is the pinned NCSC list, unmodified", () => {
    expect(createHash("sha256").update(content).digest("hex")).toBe(
      LIST_SHA256,
    );
  });

  it("holds only entries the length rule would otherwise allow", () => {
    expect(entries.length).toBe(47_324);
    expect(entries.every((entry) => [...entry].length >= 8)).toBe(true);
  });
});

describe("checkPasswordLength", () => {
  it("rejects 7 characters and accepts 8", () => {
    expect(checkPasswordLength("a".repeat(7)).ok).toBe(false);
    expect(checkPasswordLength("a".repeat(8)).ok).toBe(true);
  });

  it("counts characters, not UTF-16 code units", () => {
    expect(checkPasswordLength("🔒".repeat(4)).ok).toBe(false);
    expect(checkPasswordLength("🔒".repeat(8)).ok).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(checkPasswordLength("").ok).toBe(false);
  });

  it("accepts 72 bytes and rejects 73", () => {
    expect(checkPasswordLength("a".repeat(72)).ok).toBe(true);
    expect(checkPasswordLength("a".repeat(73)).ok).toBe(false);
  });

  it("counts the byte limit in UTF-8, as bcrypt does", () => {
    // "é" is 2 bytes: 36 fit, 37 do not, though both are under 72 characters.
    expect(checkPasswordLength("é".repeat(36)).ok).toBe(true);
    expect(checkPasswordLength("é".repeat(37)).ok).toBe(false);
    // "🔒" is 4 bytes.
    expect(checkPasswordLength("🔒".repeat(18)).ok).toBe(true);
    expect(checkPasswordLength("🔒".repeat(19)).ok).toBe(false);
  });

  it("explains the byte limit in terms a person can act on", () => {
    const result = checkPasswordLength("a".repeat(73));
    if (result.ok) throw new Error("expected a rejection");
    expect(result.reason).toContain("too long");
  });
});

describe("checkPassword", () => {
  it.each(["password", "12345678", "iloveyou", "PASSWORD", "PassWord"])(
    "rejects the common password %j, ignoring case",
    (password) => {
      expect(isCommonPassword(password)).toBe(true);
      expect(checkPassword(password).ok).toBe(false);
    },
  );

  it("rejects a short password with the length reason", () => {
    const result = checkPassword("abc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("8 characters");
  });

  it("rejects a password bcrypt would truncate", () => {
    expect(checkPassword("x".repeat(73)).ok).toBe(false);
  });

  it("accepts a long uncommon password", () => {
    expect(checkPassword("clinic-north-wing-2026-ledger").ok).toBe(true);
  });

  it("does not treat padding around a common password as common", () => {
    expect(checkPassword(" password").ok).toBe(true);
  });
});
