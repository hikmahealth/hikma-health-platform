import { useEffect, type FormEvent } from "react";
import { useImmerReducer } from "use-immer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkPasswordLength } from "@/lib/setup/password-policy";
import type {
  SetupInput,
  SetupOutcome,
  TokenCheck,
} from "@/lib/setup/complete-setup";
import type { RateLimited } from "@/lib/server-functions/setup";

export type SetupWizardProps = {
  checkToken: (token: string) => Promise<TokenCheck | RateLimited>;
  completeSetup: (input: SetupInput) => Promise<SetupOutcome | RateLimited>;
};

type Values = SetupInput & { confirmPassword: string };

type StepFields = {
  unlock: "token";
  organization:
    "organizationName" | "clinicName" | "clinicCountry" | "clinicCity";
  admin:
    | "adminName"
    | "adminEmail"
    | "adminPassword"
    | "confirmPassword"
    | "acknowledgedDataResponsibility";
};
type FormStep = keyof StepFields;
type Field = StepFields[FormStep];
type TextFieldName = Exclude<Field, "acknowledgedDataResponsibility">;

/** Errors can only name fields shown on the step that holds them. */
type FieldErrors<S extends FormStep> = Partial<Record<StepFields[S], string>>;

type Status<S extends FormStep> =
  | { kind: "editing" }
  | { kind: "invalid"; errors: FieldErrors<S> }
  | { kind: "notice"; message: string }
  | { kind: "submitting" };

type FormScreen =
  | { step: "unlock"; values: Values; status: Status<"unlock"> }
  | {
      step: "organization";
      values: Values;
      // Nothing is sent to the server from this step.
      status: Exclude<Status<"organization">, { kind: "submitting" }>;
    }
  | { step: "admin"; values: Values; status: Status<"admin"> };

export type WizardState = {
  insecure: boolean;
  screen: FormScreen | { step: "done" };
};

export type WizardAction =
  | { type: "origin-checked"; insecure: boolean }
  | { type: "text-changed"; field: TextFieldName; value: string }
  | { type: "acknowledgement-changed"; checked: boolean }
  | { type: "submitted" }
  | { type: "back" }
  | { type: "token-checked"; result: TokenCheck | RateLimited }
  | { type: "setup-answered"; result: SetupOutcome | RateLimited }
  | { type: "request-failed" };

const EMPTY: Values = {
  token: "",
  organizationName: "",
  clinicName: "",
  clinicCountry: "",
  clinicCity: "",
  adminName: "",
  adminEmail: "",
  adminPassword: "",
  confirmPassword: "",
  acknowledgedDataResponsibility: false,
};

export const INITIAL_WIZARD_STATE: WizardState = {
  insecure: false,
  screen: { step: "unlock", values: EMPTY, status: { kind: "editing" } },
};

const STEP_TITLES: Record<FormStep, string> = {
  unlock: "Unlock setup",
  organization: "Your organization",
  admin: "Your administrator account",
};

const STEP_NUMBERS: Record<FormStep, number> = {
  unlock: 1,
  organization: 2,
  admin: 3,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Plain HTTP to anything but this machine exposes the token and password. */
export const isInsecureOrigin = (protocol: string, hostname: string): boolean =>
  protocol === "http:" && !LOCAL_HOSTS.has(hostname);

const rateLimitMessage = (retryAfterMs: number): string =>
  `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfterMs / 60_000))} minute(s).`;

const ALREADY_COMPLETE =
  "This server has already been set up. Sign in with your administrator account.";

const NETWORK_FAILURE =
  "Could not reach the server. Check your connection and try again.";

/** Client-side checks for each step; the server re-checks everything. */
const validate = {
  unlock: (values: Values): FieldErrors<"unlock"> => {
    const errors: FieldErrors<"unlock"> = {};
    if (values.token.trim() === "") errors.token = "Enter the setup token";
    return errors;
  },
  organization: (values: Values): FieldErrors<"organization"> => {
    const errors: FieldErrors<"organization"> = {};
    if (values.organizationName.trim() === "") {
      errors.organizationName = "Enter your organization's name";
    }
    if (values.clinicName.trim() === "") {
      errors.clinicName = "Enter a clinic name";
    }
    return errors;
  },
  admin: (values: Values): FieldErrors<"admin"> => {
    const errors: FieldErrors<"admin"> = {};
    if (values.adminName.trim() === "") errors.adminName = "Enter your name";
    if (!/^[^\s@]+@[^\s@]+$/.test(values.adminEmail.trim())) {
      errors.adminEmail = "Enter a valid email address";
    }
    const password = checkPasswordLength(values.adminPassword);
    if (!password.ok) errors.adminPassword = password.reason;
    if (values.confirmPassword !== values.adminPassword) {
      errors.confirmPassword = "Passwords do not match";
    }
    if (!values.acknowledgedDataResponsibility) {
      errors.acknowledgedDataResponsibility =
        "Confirm that you are responsible for this data";
    }
    return errors;
  },
} satisfies { [S in FormStep]: (values: Values) => FieldErrors<S> };

const hasErrors = (errors: object): boolean => Object.keys(errors).length > 0;

const isStepValid = (screen: FormScreen): boolean =>
  !hasErrors(validate[screen.step](screen.values));

const toSetupInput = ({
  confirmPassword: _,
  ...values
}: Values): SetupInput => ({
  ...values,
  token: values.token.trim(),
  organizationName: values.organizationName.trim(),
  clinicName: values.clinicName.trim(),
  clinicCountry: values.clinicCountry.trim(),
  clinicCity: values.clinicCity.trim(),
  adminName: values.adminName.trim(),
  adminEmail: values.adminEmail.trim().toLowerCase(),
});

const editing = { kind: "editing" } as const;

/** Moves to the step that shows `field`, with `message` on it. */
const rejectField = (
  values: Values,
  field: keyof SetupInput,
  message: string,
): FormScreen => {
  switch (field) {
    case "token":
      return {
        step: "unlock",
        values,
        status: { kind: "invalid", errors: { token: message } },
      };
    case "organizationName":
    case "clinicName":
    case "clinicCountry":
    case "clinicCity": {
      const errors: FieldErrors<"organization"> = {};
      errors[field] = message;
      return {
        step: "organization",
        values,
        status: { kind: "invalid", errors },
      };
    }
    case "adminName":
    case "adminEmail":
    case "adminPassword":
    case "acknowledgedDataResponsibility": {
      const errors: FieldErrors<"admin"> = {};
      errors[field] = message;
      return { step: "admin", values, status: { kind: "invalid", errors } };
    }
    default:
      return field satisfies never;
  }
};

/** Every wizard transition. Server results are ignored unless a request is in flight. */
export const wizardReducer = (
  draft: WizardState,
  action: WizardAction,
): void => {
  if (action.type === "origin-checked") {
    draft.insecure = action.insecure;
    return;
  }

  const screen = draft.screen;
  if (screen.step === "done") return;

  switch (action.type) {
    case "text-changed":
      screen.values[action.field] = action.value;
      return;

    case "acknowledgement-changed":
      screen.values.acknowledgedDataResponsibility = action.checked;
      return;

    case "submitted": {
      if (screen.status.kind === "submitting") return;
      if (screen.step === "unlock") {
        const errors = validate.unlock(screen.values);
        screen.status = hasErrors(errors)
          ? { kind: "invalid", errors }
          : { kind: "submitting" };
      } else if (screen.step === "organization") {
        const errors = validate.organization(screen.values);
        if (hasErrors(errors)) {
          screen.status = { kind: "invalid", errors };
        } else {
          draft.screen = {
            step: "admin",
            values: screen.values,
            status: editing,
          };
        }
      } else {
        const errors = validate.admin(screen.values);
        screen.status = hasErrors(errors)
          ? { kind: "invalid", errors }
          : { kind: "submitting" };
      }
      return;
    }

    case "back": {
      if (screen.status.kind === "submitting") return;
      // Field errors belong to the step being left; a notice still applies.
      const status =
        screen.status.kind === "notice"
          ? { kind: "notice" as const, message: screen.status.message }
          : editing;
      if (screen.step === "admin") {
        draft.screen = { step: "organization", values: screen.values, status };
      } else if (screen.step === "organization") {
        draft.screen = { step: "unlock", values: screen.values, status };
      }
      return;
    }

    case "token-checked": {
      if (screen.step !== "unlock") return;
      if (screen.status.kind !== "submitting") return;
      const { result } = action;
      switch (result.kind) {
        case "valid":
          draft.screen = {
            step: "organization",
            values: screen.values,
            status: editing,
          };
          return;
        case "invalid-token":
          screen.status = {
            kind: "invalid",
            errors: { token: "That setup token is not correct" },
          };
          return;
        case "already-complete":
          screen.status = { kind: "notice", message: ALREADY_COMPLETE };
          return;
        case "rate-limited":
          screen.status = {
            kind: "notice",
            message: rateLimitMessage(result.retryAfterMs),
          };
          return;
        default:
          result satisfies never;
          return;
      }
    }

    case "setup-answered": {
      if (screen.step !== "admin") return;
      if (screen.status.kind !== "submitting") return;
      const { result } = action;
      switch (result.kind) {
        case "completed":
          draft.screen = { step: "done" };
          return;
        case "invalid-input":
          draft.screen = rejectField(
            screen.values,
            result.field,
            result.message,
          );
          return;
        case "invalid-token":
          draft.screen = rejectField(
            screen.values,
            "token",
            "That setup token is no longer valid",
          );
          return;
        case "already-complete":
          screen.status = { kind: "notice", message: ALREADY_COMPLETE };
          return;
        case "rate-limited":
          screen.status = {
            kind: "notice",
            message: rateLimitMessage(result.retryAfterMs),
          };
          return;
        default:
          result satisfies never;
          return;
      }
    }

    case "request-failed":
      if (screen.status.kind !== "submitting") return;
      screen.status = { kind: "notice", message: NETWORK_FAILURE };
      return;

    default:
      action satisfies never;
      return;
  }
};

/** The three-step first-run wizard. Server calls are injected so it can be tested alone. */
export function SetupWizard({ checkToken, completeSetup }: SetupWizardProps) {
  const [state, dispatch] = useImmerReducer(
    wizardReducer,
    INITIAL_WIZARD_STATE,
  );
  const { screen } = state;

  // Read after mount: the server render cannot know the browser's protocol.
  useEffect(() => {
    dispatch({
      type: "origin-checked",
      insecure: isInsecureOrigin(
        window.location.protocol,
        window.location.hostname,
      ),
    });
  }, [dispatch]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (screen.step === "done") return;
    if (screen.status.kind === "submitting") return;
    dispatch({ type: "submitted" });
    if (screen.step === "organization") return;
    if (!isStepValid(screen)) return;

    try {
      if (screen.step === "unlock") {
        const result = await checkToken(screen.values.token.trim());
        dispatch({ type: "token-checked", result });
      } else {
        const result = await completeSetup(toSetupInput(screen.values));
        dispatch({ type: "setup-answered", result });
      }
    } catch {
      dispatch({ type: "request-failed" });
    }
  };

  if (screen.step === "done") return <SetupComplete />;

  const { step, values, status } = screen;
  const errors: Partial<Record<Field, string>> =
    status.kind === "invalid" ? status.errors : {};
  const notice = status.kind === "notice" ? status.message : null;
  const submitting = status.kind === "submitting";
  const setText = (field: TextFieldName) => (value: string) =>
    dispatch({ type: "text-changed", field, value });

  return (
    <div className="container mx-auto flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Set up Hikma Health</h1>
          <p className="text-sm text-muted-foreground">
            Step {STEP_NUMBERS[step]} of 3 · {STEP_TITLES[step]}
          </p>
        </div>

        {state.insecure && (
          <Alert variant="destructive" data-testid="insecure-connection">
            <AlertTitle>This connection is not secure</AlertTitle>
            <AlertDescription>
              This page was loaded over plain HTTP, so the setup token and your
              password can be read by anyone on the network. Use an https://
              address before entering them if you can.
            </AlertDescription>
          </Alert>
        )}

        {notice && (
          <Alert data-testid="setup-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        <form
          onSubmit={onSubmit}
          noValidate
          className="space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-md"
        >
          {step === "unlock" && (
            <>
              <p className="text-sm text-muted-foreground">
                The setup token is printed in the server logs when it starts, or
                is the SETUP_TOKEN value you configured for this deployment.
              </p>
              <TextField
                id="token"
                label="Setup token"
                value={values.token}
                onChange={setText("token")}
                error={errors.token}
                autoComplete="off"
              />
            </>
          )}

          {step === "organization" && (
            <>
              <TextField
                id="organizationName"
                label="Organization name"
                value={values.organizationName}
                onChange={setText("organizationName")}
                error={errors.organizationName}
              />
              <TextField
                id="clinicName"
                label="Clinic name"
                value={values.clinicName}
                onChange={setText("clinicName")}
                error={errors.clinicName}
              />
              <TextField
                id="clinicCountry"
                label="Country (optional)"
                value={values.clinicCountry}
                onChange={setText("clinicCountry")}
                error={errors.clinicCountry}
              />
              <TextField
                id="clinicCity"
                label="City (optional)"
                value={values.clinicCity}
                onChange={setText("clinicCity")}
                error={errors.clinicCity}
              />
            </>
          )}

          {step === "admin" && (
            <>
              <TextField
                id="adminName"
                label="Your name"
                value={values.adminName}
                onChange={setText("adminName")}
                error={errors.adminName}
                autoComplete="name"
              />
              <TextField
                id="adminEmail"
                label="Email"
                type="email"
                value={values.adminEmail}
                onChange={setText("adminEmail")}
                error={errors.adminEmail}
                autoComplete="email"
              />
              <TextField
                id="adminPassword"
                label="Password"
                type="password"
                value={values.adminPassword}
                onChange={setText("adminPassword")}
                error={errors.adminPassword}
                autoComplete="new-password"
                hint="At least 8 characters. Common passwords are not allowed."
              />
              <TextField
                id="confirmPassword"
                label="Confirm password"
                type="password"
                value={values.confirmPassword}
                onChange={setText("confirmPassword")}
                error={errors.confirmPassword}
                autoComplete="new-password"
              />
              <div className="space-y-1">
                <div className="flex items-start gap-2">
                  <input
                    id="acknowledgedDataResponsibility"
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={values.acknowledgedDataResponsibility}
                    onChange={(event) =>
                      dispatch({
                        type: "acknowledgement-changed",
                        checked: event.target.checked,
                      })
                    }
                    aria-invalid={
                      errors.acknowledgedDataResponsibility ? true : undefined
                    }
                  />
                  <Label
                    htmlFor="acknowledgedDataResponsibility"
                    className="text-sm leading-snug font-normal"
                  >
                    This system will hold patient health data. I am responsible
                    for who gets access and for backups.
                  </Label>
                </div>
                <FieldError message={errors.acknowledgedDataResponsibility} />
              </div>
            </>
          )}

          <div className="flex gap-2">
            {step !== "unlock" && (
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => dispatch({ type: "back" })}
              >
                Back
              </Button>
            )}
            <Button type="submit" className="flex-1" disabled={submitting}>
              {submitting
                ? "Please wait..."
                : step === "admin"
                  ? "Finish setup"
                  : "Continue"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SetupComplete() {
  return (
    <div className="container mx-auto flex min-h-screen flex-col items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-gray-200 bg-white p-6 text-center shadow-md">
        <h1 className="text-2xl font-bold">You're set up</h1>
        <p className="text-sm text-muted-foreground">
          Sign in with the email and password you just chose. Next, invite your
          team, pair a mobile device, and set up backups.
        </p>
        <Button asChild className="w-full">
          <a href="/">Sign in</a>
        </Button>
      </div>
    </div>
  );
}

type TextFieldProps = {
  id: Field;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  hint?: string;
};

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  type = "text",
  autoComplete,
  hint,
}: TextFieldProps) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      <FieldError message={error} />
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm text-destructive">{message}</p>;
}
