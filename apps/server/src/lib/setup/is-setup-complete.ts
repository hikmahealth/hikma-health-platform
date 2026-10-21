import db from "@/db";
import { createSetupStatus } from "./setup-status";

/** The process-wide setup check against the app database. */
export const isSetupComplete = createSetupStatus(db);
