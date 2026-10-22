// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../../src");

/** Admin and security surfaces whose every write must reach the audit log. */
const AUDITED_FILES = [
  "lib/server-functions/users.ts",
  "lib/server-functions/clinics.ts",
  "lib/server-functions/drugs.ts",
  "lib/server-functions/inventory.ts",
  "routes/app/users.index.tsx",
  "routes/app/users.edit.$.tsx",
  "routes/app/users.manage-permissions.$.tsx",
  "routes/app/settings.devices.index.tsx",
  "routes/app/settings.devices.edit.$.tsx",
  "routes/app/settings.configurations.index.tsx",
  "routes/app/settings.configurations.patient-view-actions.tsx",
  "routes/app/clinics.index.tsx",
  "routes/app/clinics.edit.$.tsx",
  "routes/app/event-forms.edit.$.tsx",
  "routes/app/event-forms.index.tsx",
  "routes/app/patients.customize-registration-form.tsx",
];

/** Each `createServerFn(...)` declaration, up to the next one. */
const serverFunctions = (source: string) =>
  source
    .split(/(?=(?:export )?const \w+ = createServerFn\()/)
    .slice(1)
    .map((block) => ({
      name: /const (\w+)/.exec(block)?.[1] ?? "?",
      isWrite: /createServerFn\(\{\s*method: "POST"/.test(block),
      block,
    }));

describe("admin audit coverage", () => {
  const cases = AUDITED_FILES.flatMap((file) =>
    serverFunctions(readFileSync(join(SRC, file), "utf8"))
      .filter((fn) => fn.isWrite)
      .map((fn) => [`${file} ${fn.name}`, fn.block] as const),
  );

  it("finds the write functions it is meant to guard", () => {
    expect(cases.length).toBeGreaterThanOrEqual(36);
  });

  it.each(cases)("%s records an audit event", (_, block) => {
    expect(block).toMatch(/\b(logAdminAudit|logAuditEvent)\(/);
  });

  it("records each patient record read", () => {
    const source = readFileSync(
      join(SRC, "lib/server-functions/patients.tsx"),
      "utf8",
    );
    const read = serverFunctions(source).find(
      (fn) => fn.name === "getPatientById",
    );
    expect(read?.block).toMatch(/logAuditEvent\(\{\s*actionType: "VIEW"/);
  });
});
