import { test as setup, expect, type Page } from "@playwright/test";
import { E2E_SETUP_TOKEN } from "./setup-token";

/** Claims a fresh server through /setup as VITE_ADMIN_EMAIL / VITE_ADMIN_PASS; a no-op once set up. */

const isSetupComplete = async (page: Page): Promise<boolean> => {
  const response = await page.request.get("/api/setup/status");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { complete: boolean }).complete;
};

const continueButton = (page: Page) =>
  page.getByRole("button", { name: /continue|finish setup/i });

setup("complete first-run setup", async ({ page }) => {
  if (await isSetupComplete(page)) return;

  const email = process.env.VITE_ADMIN_EMAIL;
  const password = process.env.VITE_ADMIN_PASS;
  if (!email || !password) {
    throw new Error(
      "VITE_ADMIN_EMAIL and VITE_ADMIN_PASS must be set: they become the first admin",
    );
  }

  await page.goto("/setup");
  // Typing before hydration would be lost to React's controlled inputs.
  await page.waitForLoadState("networkidle");

  await page.getByLabel("Setup token").fill(E2E_SETUP_TOKEN);
  await continueButton(page).click();
  const organizationName = page.getByLabel("Organization name");
  const tokenRejected = page.getByText("That setup token is not correct");
  await expect(organizationName.or(tokenRejected)).toBeVisible();
  if (await tokenRejected.isVisible()) {
    throw new Error(
      "The server rejected the e2e setup token. A reused dev server did not get " +
        "Playwright's SETUP_TOKEN: set SETUP_TOKEN in .env and restart the dev server.",
    );
  }

  await organizationName.fill("E2E Health Organization");
  await page.getByLabel("Clinic name").fill("E2E Clinic");
  await continueButton(page).click();

  await page.getByLabel("Your name").fill("E2E Admin");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByLabel(/patient health data/i).check();
  await continueButton(page).click();

  const done = page.getByText("You're set up");
  const problem = page.locator(
    "p.text-destructive, [data-testid=setup-notice]",
  );
  await expect(done.or(problem.first())).toBeVisible();
  if (!(await done.isVisible())) {
    throw new Error(
      `Setup was rejected: ${await problem.first().innerText()}. ` +
        "VITE_ADMIN_PASS must be at least 8 characters and not a common password.",
    );
  }

  expect(await isSetupComplete(page)).toBe(true);
});
