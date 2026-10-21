import { isSetupComplete } from "./is-setup-complete";

/** What API callers get while first-run setup is pending. Mobile cannot follow redirects. */
export const setupRequiredResponse = (): Response =>
  Response.json(
    { error: "setup_required" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );

/** `null` once setup is complete, otherwise the response to send instead of handling the request. */
export const rejectWhileSetupPending = async (): Promise<Response | null> =>
  (await isSetupComplete()) ? null : setupRequiredResponse();
