// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import { createPglite, createPgliteKysely } from "../helpers/pglite-kysely";
import * as initialTables from "../../../../database/migrations/20191125_initial_tables";
import * as initialUser from "../../../../database/migrations/20191126_initial_user";
import * as instanceSetup from "../../../../database/migrations/20261021_create_instance_setup";
import {
  SETUP_TOKEN_PLACEHOLDER,
  announceSetupToken,
  formatSetupAnnouncement,
  generateSetupToken,
  getOrCreateSetupToken,
  resetSetupToken,
  resolveSetupToken,
  setupTokenAccepts,
  setupTokenMatches,
} from "@/lib/setup/setup-token";
import { createSetupStatus } from "@/lib/setup/setup-status";

const ENV_TOKEN = "an-operator-chosen-passphrase-0001";

describe("resolveSetupToken", () => {
  it.each([undefined, "", "   ", "\n"])("treats %j as unset", (raw) => {
    expect(resolveSetupToken(raw)).toEqual({ kind: "unset" });
  });

  it("treats the public DigitalOcean placeholder as unset", () => {
    expect(resolveSetupToken(SETUP_TOKEN_PLACEHOLDER)).toEqual({
      kind: "unset",
    });
    expect(resolveSetupToken(` ${SETUP_TOKEN_PLACEHOLDER}\n`)).toEqual({
      kind: "unset",
    });
  });

  it("rejects a value one character short of the minimum", () => {
    expect(resolveSetupToken("x".repeat(23)).kind).toBe("invalid");
  });

  it("accepts a value at the minimum, trimmed", () => {
    expect(resolveSetupToken(` ${"x".repeat(24)}\n`)).toEqual({
      kind: "configured",
      token: "x".repeat(24),
    });
  });
});

describe("generateSetupToken", () => {
  it("is 32 base32 characters (160 bits) in groups of four", () => {
    expect(generateSetupToken()).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSetupToken));
    expect(tokens.size).toBe(200);
  });
});

describe("setupTokenMatches", () => {
  const token = generateSetupToken();

  it("matches the exact token, ignoring surrounding whitespace", () => {
    expect(setupTokenMatches(token, token)).toBe(true);
    expect(setupTokenMatches(` ${token}\n`, token)).toBe(true);
  });

  it("rejects a token differing in one character", () => {
    const altered = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(setupTokenMatches(altered, token)).toBe(false);
  });

  it("rejects candidates of any other length without throwing", () => {
    for (const candidate of ["", "A", token + "A", token.slice(0, -1)]) {
      expect(setupTokenMatches(candidate, token)).toBe(false);
    }
  });

  it("matches nothing when no token is expected", () => {
    expect(setupTokenMatches("", null)).toBe(false);
    expect(setupTokenMatches(token, null)).toBe(false);
  });
});

describe("setupTokenAccepts", () => {
  const UNSET = { kind: "unset" } as const;
  const stored = generateSetupToken();

  it("prefers the env token and ignores a stored one", () => {
    const configured = resolveSetupToken(ENV_TOKEN);
    expect(setupTokenAccepts(ENV_TOKEN, stored, configured)).toBe(true);
    expect(setupTokenAccepts(stored, stored, configured)).toBe(false);
  });

  it("uses the stored token when no env token is set", () => {
    expect(setupTokenAccepts(stored, stored, UNSET)).toBe(true);
  });

  it("forgives case, dashes and spaces in a generated token", () => {
    const retyped = stored.toLowerCase().replace(/-/g, " ");
    expect(setupTokenAccepts(retyped, stored, UNSET)).toBe(true);
    expect(setupTokenAccepts(stored.replace(/-/g, ""), stored, UNSET)).toBe(
      true,
    );
  });

  it("still rejects a generated token with one character changed", () => {
    const altered = (stored[0] === "A" ? "B" : "A") + stored.slice(1);
    expect(setupTokenAccepts(altered, stored, UNSET)).toBe(false);
  });

  it("requires an env token to match exactly, case included", () => {
    const configured = resolveSetupToken(ENV_TOKEN);
    expect(setupTokenAccepts(ENV_TOKEN.toUpperCase(), null, configured)).toBe(
      false,
    );
    expect(
      setupTokenAccepts(ENV_TOKEN.replace(/-/g, ""), null, configured),
    ).toBe(false);
  });

  it("accepts nothing when no token has been generated yet", () => {
    expect(setupTokenAccepts("", null, UNSET)).toBe(false);
  });

  it("accepts nothing when the env token is invalid", () => {
    expect(
      setupTokenAccepts(stored, stored, resolveSetupToken("too-short")),
    ).toBe(false);
  });

  it("never accepts the placeholder as a token", () => {
    const configured = resolveSetupToken(SETUP_TOKEN_PLACEHOLDER);
    expect(setupTokenAccepts(SETUP_TOKEN_PLACEHOLDER, null, configured)).toBe(
      false,
    );
  });
});

describe("formatSetupAnnouncement", () => {
  const url = "https://clinic.example.org/";

  it("shows the URL and token for a generated token", () => {
    const message = formatSetupAnnouncement(
      { kind: "generated", token: "ABCD-EFGH" },
      { kind: "unset" },
      url,
    );
    expect(message).toContain("https://clinic.example.org/setup");
    expect(message).toContain("ABCD-EFGH");
  });

  it("never prints an env token", () => {
    const message = formatSetupAnnouncement(
      { kind: "from-env" },
      resolveSetupToken(ENV_TOKEN),
      url,
    );
    expect(message).not.toContain(ENV_TOKEN);
    expect(message).toContain("/setup");
  });

  it("says nothing once setup is complete and no env token is set", () => {
    expect(
      formatSetupAnnouncement({ kind: "complete" }, { kind: "unset" }, url),
    ).toBeNull();
  });

  it("notes that a leftover env token is unused after setup", () => {
    const message = formatSetupAnnouncement(
      { kind: "complete" },
      resolveSetupToken(ENV_TOKEN),
      url,
    );
    expect(message).toContain("no longer used");
    expect(message).not.toContain(ENV_TOKEN);
  });
});

describe("with a database", () => {
  let db: Kysely<DB>;

  const pendingInstall = async () => {
    await initialTables.up(db);
    await initialUser.up(db);
    await instanceSetup.up(db);
  };

  const completeSetup = () =>
    db
      .updateTable("instance_setup")
      .set({ completed_at: new Date(), token: null })
      .where("id", "=", 1)
      .execute();

  const storedToken = async () =>
    (
      await db
        .selectFrom("instance_setup")
        .select("token")
        .executeTakeFirstOrThrow()
    ).token;

  beforeEach(() => {
    db = createPgliteKysely() as Kysely<DB>;
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("resetSetupToken", () => {
    it("discards a generated token so the next call makes a new one", async () => {
      await pendingInstall();
      const before = await getOrCreateSetupToken(db, { kind: "unset" });

      expect(await resetSetupToken(db)).toBe(true);
      expect(await storedToken()).toBeNull();
      const after = await getOrCreateSetupToken(db, { kind: "unset" });

      expect(after.kind).toBe("generated");
      expect(after).not.toEqual(before);
    });

    it("reports nothing to reset when no token was generated", async () => {
      await pendingInstall();

      expect(await resetSetupToken(db)).toBe(false);
    });

    it("does nothing once setup is complete", async () => {
      await pendingInstall();
      await getOrCreateSetupToken(db, { kind: "unset" });
      await db
        .updateTable("instance_setup")
        .set({ completed_at: new Date() })
        .execute();
      const tokenBefore = await storedToken();

      expect(await resetSetupToken(db)).toBe(false);
      expect(await storedToken()).toBe(tokenBefore);
    });
  });

  describe("getOrCreateSetupToken", () => {
    it("generates and stores a token on a pending install", async () => {
      await pendingInstall();

      const state = await getOrCreateSetupToken(db, { kind: "unset" });

      expect(state.kind).toBe("generated");
      if (state.kind !== "generated") return;
      expect(await storedToken()).toBe(state.token);
    });

    it("returns the same token on every later call", async () => {
      await pendingInstall();

      const first = await getOrCreateSetupToken(db, { kind: "unset" });
      const second = await getOrCreateSetupToken(db, { kind: "unset" });

      expect(second).toEqual(first);
    });

    it("gives concurrent callers the same token", async () => {
      await pendingInstall();

      const states = await Promise.all(
        Array.from({ length: 8 }, () =>
          getOrCreateSetupToken(db, { kind: "unset" }),
        ),
      );

      expect(new Set(states.map((state) => JSON.stringify(state))).size).toBe(
        1,
      );
      expect(states[0]?.kind).toBe("generated");
    });

    it("keeps a token another instance wrote between its read and its write", async () => {
      await db.destroy();
      const pglite = createPglite();
      db = pglite.db as Kysely<DB>;
      await pendingInstall();
      let raced = false;
      const racingDb = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: async (args) => {
          const firstRow = args.result.rows[0] as
            { token?: unknown } | undefined;
          if (!raced && firstRow?.token === null) {
            raced = true;
            await pglite.query(
              "UPDATE instance_setup SET token = 'OTHER-INSTANCE-TOKEN'",
            );
          }
          return args.result;
        },
      });

      const state = await getOrCreateSetupToken(racingDb, { kind: "unset" });

      expect(raced).toBe(true);
      expect(state).toEqual({
        kind: "generated",
        token: "OTHER-INSTANCE-TOKEN",
      });
      expect(await storedToken()).toBe("OTHER-INSTANCE-TOKEN");
    });

    it("leaves the column empty when an env token is configured", async () => {
      await pendingInstall();

      const state = await getOrCreateSetupToken(
        db,
        resolveSetupToken(ENV_TOKEN),
      );

      expect(state).toEqual({ kind: "from-env" });
      expect(await storedToken()).toBeNull();
    });

    it("reports a too-short env token instead of generating one", async () => {
      await pendingInstall();

      const state = await getOrCreateSetupToken(db, resolveSetupToken("short"));

      expect(state.kind).toBe("misconfigured");
      expect(await storedToken()).toBeNull();
    });

    it("is complete once setup has finished", async () => {
      await pendingInstall();
      await completeSetup();

      expect(await getOrCreateSetupToken(db, { kind: "unset" })).toEqual({
        kind: "complete",
      });
      expect(await storedToken()).toBeNull();
    });

    it("is complete when the row is missing", async () => {
      await pendingInstall();
      await db.deleteFrom("instance_setup").execute();

      expect(await getOrCreateSetupToken(db, { kind: "unset" })).toEqual({
        kind: "complete",
      });
    });
  });

  describe("announceSetupToken", () => {
    it("does not throw when the setup table does not exist", async () => {
      await expect(announceSetupToken(db)).resolves.toEqual({
        kind: "complete",
      });
    });
  });

  describe("createSetupStatus", () => {
    it("is pending on a fresh install and complete after setup", async () => {
      await pendingInstall();
      const isSetupComplete = createSetupStatus(db);

      expect(await isSetupComplete()).toBe(false);
      await completeSetup();
      expect(await isSetupComplete()).toBe(true);
    });

    it("stays complete once seen complete, even if the row later changes", async () => {
      await pendingInstall();
      await completeSetup();
      const isSetupComplete = createSetupStatus(db);

      expect(await isSetupComplete()).toBe(true);
      await db
        .updateTable("instance_setup")
        .set({ completed_at: null })
        .execute();
      expect(await isSetupComplete()).toBe(true);
    });

    it("counts a missing row as complete", async () => {
      await pendingInstall();
      await db.deleteFrom("instance_setup").execute();

      expect(await createSetupStatus(db)()).toBe(true);
    });

    it("counts a missing table as complete", async () => {
      expect(await createSetupStatus(db)()).toBe(true);
    });

    it("does not cache a failed read as complete", async () => {
      const isSetupComplete = createSetupStatus(db);
      expect(await isSetupComplete()).toBe(true);

      await pendingInstall();
      expect(await isSetupComplete()).toBe(false);
    });
  });
});
