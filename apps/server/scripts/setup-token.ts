/**
 * Boot step: prints the setup token while setup is pending; `--reset` replaces
 * a generated one. Fails boot only for an unusable SETUP_TOKEN, never for an
 * unreadable setup state.
 */

import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { Logger } from "@hikmahealth/js-utils";
import { getDatabaseConfig } from "@hikmahealth/database/config";
import type { DB } from "@hikmahealth/database/types/schema/hh";
import {
  announceSetupToken,
  resetSetupToken,
  resolveSetupToken,
} from "../src/lib/setup/setup-token";

const reset = async (db: Kysely<DB>): Promise<void> => {
  if (resolveSetupToken().kind === "configured") {
    Logger.Production.log(
      "SETUP_TOKEN is set, so it is the setup token. Change or unset it to rotate.",
    );
    return;
  }
  const cleared = await resetSetupToken(db);
  if (!cleared) Logger.Production.log("No generated setup token to reset.");
};

const isReset = process.argv.includes("--reset");

const main = async (): Promise<number> => {
  // Owns its pool: this runs as its own process before the server starts.
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: new Pool(getDatabaseConfig()) }),
  });
  try {
    if (isReset) await reset(db);
    const state = await announceSetupToken(db);
    return state.kind === "misconfigured" ? 1 : 0;
  } finally {
    await db.destroy();
  }
};

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    Logger.Production.error({ msg: "Setup token step failed", error });
    // A manual reset should report failure; a boot must carry on regardless.
    process.exit(isReset ? 1 : 0);
  });
