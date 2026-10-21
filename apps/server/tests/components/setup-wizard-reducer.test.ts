import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
  INITIAL_WIZARD_STATE,
  type WizardAction,
  type WizardState,
  wizardReducer,
} from "@/components/setup/setup-wizard";

const run = (state: WizardState, ...actions: WizardAction[]): WizardState =>
  actions.reduce(
    (current, action) =>
      produce(current, (draft) => wizardReducer(draft, action)),
    state,
  );

const type = (
  field: "token" | "organizationName" | "clinicName",
  value: string,
) => ({ type: "text-changed", field, value }) as const;

const submittingUnlock = run(INITIAL_WIZARD_STATE, type("token", "TOKEN"), {
  type: "submitted",
});

const onAdmin = run(
  submittingUnlock,
  { type: "token-checked", result: { kind: "valid" } },
  type("organizationName", "Northern Health"),
  type("clinicName", "North Wing"),
  { type: "submitted" },
);

// Reached in the UI by submitting a valid admin step.
const submittingAdmin = produce(onAdmin, (draft) => {
  if (draft.screen.step === "admin")
    draft.screen.status = { kind: "submitting" };
});

describe("wizardReducer", () => {
  it("submits a valid token and waits for the server", () => {
    expect(submittingUnlock.screen).toMatchObject({
      step: "unlock",
      status: { kind: "submitting" },
    });
    expect(submittingAdmin.screen).toMatchObject({
      step: "admin",
      status: { kind: "submitting" },
    });
  });

  it("ignores a second submit while a request is in flight", () => {
    expect(run(submittingUnlock, { type: "submitted" })).toBe(submittingUnlock);
  });

  it("ignores Back while a request is in flight", () => {
    expect(run(submittingAdmin, { type: "back" })).toBe(submittingAdmin);
  });

  it("ignores server answers that arrive when nothing is in flight", () => {
    const answers: WizardAction[] = [
      { type: "token-checked", result: { kind: "valid" } },
      {
        type: "setup-answered",
        result: { kind: "completed", userId: "u", clinicId: "c" },
      },
      { type: "request-failed" },
    ];
    for (const answer of answers) {
      expect(run(INITIAL_WIZARD_STATE, answer)).toBe(INITIAL_WIZARD_STATE);
      expect(run(onAdmin, answer)).toBe(onAdmin);
    }
  });

  it("ignores a setup answer while the token is being checked", () => {
    const answer: WizardAction = {
      type: "setup-answered",
      result: { kind: "completed", userId: "u", clinicId: "c" },
    };
    expect(run(submittingUnlock, answer)).toBe(submittingUnlock);
  });

  it("keeps entered values when going back", () => {
    const back = run(onAdmin, { type: "back" }, { type: "back" });
    expect(back.screen).toMatchObject({
      step: "unlock",
      status: { kind: "editing" },
      values: { token: "TOKEN", organizationName: "Northern Health" },
    });
  });

  it("keeps a notice but drops field errors when going back", () => {
    const limited = run(submittingAdmin, {
      type: "setup-answered",
      result: { kind: "rate-limited", retryAfterMs: 60_000 },
    });
    expect(run(limited, { type: "back" }).screen).toMatchObject({
      step: "organization",
      status: { kind: "notice", message: expect.stringMatching(/too many/i) },
    });

    const invalid = run(onAdmin, { type: "submitted" }, type("token", ""));
    expect(invalid.screen).toMatchObject({ status: { kind: "invalid" } });
    expect(run(invalid, { type: "back" }).screen).toMatchObject({
      step: "organization",
      status: { kind: "editing" },
    });
  });

  it("keeps existing errors while the user types", () => {
    const invalid = run(INITIAL_WIZARD_STATE, { type: "submitted" });
    const typed = run(invalid, type("token", "T"));
    expect(typed.screen).toMatchObject({
      status: { kind: "invalid", errors: { token: "Enter the setup token" } },
    });
  });

  it("drops the entered values once setup is done", () => {
    const done = run(submittingAdmin, {
      type: "setup-answered",
      result: { kind: "completed", userId: "u", clinicId: "c" },
    });
    expect(done.screen).toEqual({ step: "done" });
  });

  it("shows a server rejection only on the step that owns the field", () => {
    const rejected = run(submittingAdmin, {
      type: "setup-answered",
      result: {
        kind: "invalid-input",
        field: "clinicCity",
        message: "Unknown city",
      },
    });
    expect(rejected.screen).toMatchObject({
      step: "organization",
      status: { kind: "invalid", errors: { clinicCity: "Unknown city" } },
    });
  });
});
