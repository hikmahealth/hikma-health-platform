import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SetupWizard,
  type SetupWizardProps,
  isInsecureOrigin,
} from "@/components/setup/setup-wizard";

afterEach(cleanup);

const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const submit = () =>
  fireEvent.click(
    screen.getByRole("button", { name: /continue|finish setup/i }),
  );

const renderWizard = (overrides: Partial<SetupWizardProps> = {}) => {
  const props: SetupWizardProps = {
    checkToken: vi.fn(async () => ({ kind: "valid" }) as const),
    completeSetup: vi.fn(
      async () => ({ kind: "completed", userId: "u", clinicId: "c" }) as const,
    ),
    ...overrides,
  };
  render(<SetupWizard {...props} />);
  return props;
};

const unlock = async () => {
  type(/setup token/i, "  TOKEN-1234  ");
  submit();
  await screen.findByLabelText(/organization name/i);
};

const fillOrganization = async () => {
  type(/organization name/i, " Northern Health ");
  type(/clinic name/i, "North Wing");
  submit();
  await screen.findByLabelText(/your name/i);
};

const fillAdmin = (password = "clinic-north-wing-2026") => {
  type(/your name/i, "Amina");
  type(/^email$/i, " Amina@Example.org ");
  type(/^password$/i, password);
  type(/confirm password/i, password);
  fireEvent.click(screen.getByLabelText(/patient health data/i));
};

describe("SetupWizard", () => {
  it("walks the three steps and submits trimmed values", async () => {
    const props = renderWizard();

    await unlock();
    expect(props.checkToken).toHaveBeenCalledWith("TOKEN-1234");
    await fillOrganization();
    fillAdmin();
    submit();

    await screen.findByText(/you're set up/i);
    expect(props.completeSetup).toHaveBeenCalledWith({
      token: "TOKEN-1234",
      organizationName: "Northern Health",
      clinicName: "North Wing",
      clinicCountry: "",
      clinicCity: "",
      adminName: "Amina",
      adminEmail: "amina@example.org",
      adminPassword: "clinic-north-wing-2026",
      acknowledgedDataResponsibility: true,
    });
  });

  it("stays on the first step when the token is wrong", async () => {
    renderWizard({
      checkToken: vi.fn(async () => ({ kind: "invalid-token" }) as const),
    });

    type(/setup token/i, "WRONG");
    submit();

    await screen.findByText(/not correct/i);
    expect(screen.queryByLabelText(/organization name/i)).toBeNull();
  });

  it("does not call the server for an empty token", () => {
    const props = renderWizard();

    submit();

    expect(screen.getByText(/enter the setup token/i)).toBeTruthy();
    expect(props.checkToken).not.toHaveBeenCalled();
  });

  it("blocks a short password, a mismatch and a missing acknowledgement before submitting", async () => {
    const props = renderWizard();
    await unlock();
    await fillOrganization();

    type(/your name/i, "Amina");
    type(/^email$/i, "amina@example.org");
    type(/^password$/i, "short");
    type(/confirm password/i, "different");
    submit();

    expect(screen.getByText(/at least 8 characters/i)).toBeTruthy();
    expect(screen.getByText(/do not match/i)).toBeTruthy();
    expect(screen.getByText(/responsible for this data/i)).toBeTruthy();
    expect(props.completeSetup).not.toHaveBeenCalled();
  });

  it("blocks a password bcrypt would truncate", async () => {
    const props = renderWizard();
    await unlock();
    await fillOrganization();
    fillAdmin("x".repeat(73));
    submit();

    expect(screen.getByText(/too long/i)).toBeTruthy();
    expect(props.completeSetup).not.toHaveBeenCalled();
  });

  it("shows a server rejection on the step that owns the field", async () => {
    renderWizard({
      completeSetup: vi.fn(
        async () =>
          ({
            kind: "invalid-input",
            field: "clinicName",
            message: "Clinic name rejected by server",
          }) as const,
      ),
    });
    await unlock();
    await fillOrganization();
    fillAdmin();
    submit();

    await screen.findByText(/rejected by server/i);
    expect(screen.getByLabelText(/clinic name/i)).toBeTruthy();
  });

  it("returns to the token step when the token stopped working", async () => {
    renderWizard({
      completeSetup: vi.fn(async () => ({ kind: "invalid-token" }) as const),
    });
    await unlock();
    await fillOrganization();
    fillAdmin();
    submit();

    await screen.findByText(/no longer valid/i);
    expect(screen.getByLabelText(/setup token/i)).toBeTruthy();
  });

  it("reports rate limiting in minutes", async () => {
    renderWizard({
      checkToken: vi.fn(
        async () =>
          ({ kind: "rate-limited", retryAfterMs: 4 * 60_000 + 1 }) as const,
      ),
    });

    type(/setup token/i, "TOKEN");
    submit();

    expect((await screen.findByTestId("setup-notice")).textContent).toContain(
      "5 minute",
    );
  });

  it("reports a network failure instead of hanging", async () => {
    renderWizard({
      checkToken: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    type(/setup token/i, "TOKEN");
    submit();

    await screen.findByText(/could not reach the server/i);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("does not warn about the connection on localhost", () => {
    renderWizard();

    expect(screen.queryByTestId("insecure-connection")).toBeNull();
  });
});

describe("isInsecureOrigin", () => {
  it.each([
    ["http:", "clinic.example.org", true],
    ["http:", "10.0.0.5", true],
    ["https:", "clinic.example.org", false],
    ["http:", "localhost", false],
    ["http:", "127.0.0.1", false],
    ["http:", "[::1]", false],
  ])("%s//%s → %s", (protocol, hostname, expected) => {
    expect(isInsecureOrigin(protocol, hostname)).toBe(expected);
  });
});
