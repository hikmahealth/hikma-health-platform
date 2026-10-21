import type { Kysely } from "kysely";
import { Logger } from "@hikmahealth/js-utils";
import type { DB } from "@hikmahealth/database/types/schema/hh";

/**
 * Builds an `isSetupComplete` check. Anything short of a pending row counts as
 * complete, so an existing deployment is never put behind `/setup`.
 */
export const createSetupStatus = (db: Kysely<DB>) => {
  let completed = false;

  return async (): Promise<boolean> => {
    if (completed) return true;

    let row: { completed_at: Date | null } | undefined;
    try {
      row = await db
        .selectFrom("instance_setup")
        .select("completed_at")
        .where("id", "=", 1)
        .executeTakeFirst();
    } catch (error) {
      Logger.Production.error({ msg: "Could not read setup state", error });
      return true;
    }

    if (!row) return true;
    if (row.completed_at === null) return false;
    completed = true;
    return true;
  };
};
