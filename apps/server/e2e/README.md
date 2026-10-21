# End-to-End Tests

This directory contains Playwright end-to-end tests for the Hikma Health Server application.

## Setup

### Prerequisites

1. Ensure you have Node.js and pnpm installed
2. Install dependencies: `pnpm install`
3. Set up environment variables (see below)

### Environment Variables

The e2e tests require the following environment variables to be set in your `.env` file:

```env
VITE_ADMIN_EMAIL=your-admin-email@example.com
VITE_ADMIN_PASS=your-admin-password
```

These credentials are used by the authentication fixture to sign in before running tests that require authentication.

### First-run setup

On a fresh database the server waits at `/setup`. The `setup` project
(`setup.setup.ts`) runs before every browser project and completes the wizard
with `VITE_ADMIN_EMAIL` / `VITE_ADMIN_PASS` as the first admin, so:

- `VITE_ADMIN_PASS` must be at least 8 characters and not a common password,
  and `VITE_ADMIN_EMAIL` must not be `admin@hikmahealth.org`.
- Playwright starts its server with `SETUP_TOKEN` (from the environment, or a
  fixed e2e default). If you reuse a dev server you started yourself, set the
  same `SETUP_TOKEN` in `.env` before starting it.
- On a database that is already set up, the step does nothing.

## Running Tests

### Basic Commands

```bash
# Run all e2e tests
pnpm test:e2e

# Run tests with UI mode (interactive)
pnpm test:e2e:ui

# Debug tests
pnpm test:e2e:debug

# Run tests in headed mode (see browser)
pnpm test:e2e --headed

# Run a specific test file
pnpm test:e2e auth.spec.ts

# Run tests in a specific browser
pnpm test:e2e --project=chromium
pnpm test:e2e --project=firefox
pnpm test:e2e --project=webkit
```

## Test Structure

### Authentication Fixture

The authentication fixture (`fixtures/auth.ts`) provides an `authenticatedPage` that:

1. **Before each test**: Automatically signs in using the admin credentials from environment variables
2. **During the test**: Provides an authenticated page context for testing protected routes
3. **After each test**: Automatically signs out to clean up the session

### Example Usage

```typescript
import { test, expect } from "./fixtures/auth";

// Test that requires authentication
test("should access protected route", async ({ authenticatedPage }) => {
  // authenticatedPage is already signed in
  await expect(authenticatedPage.getByText("Dashboard")).toBeVisible();
  // Test continues...
  // Sign out happens automatically after test
});

// Test without authentication
test("should show login page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Sign in")).toBeVisible();
});
```

## Test Files

- `auth.spec.ts` - Authentication flow tests (sign in, sign out, session persistence)
- `fixtures/auth.ts` - Authentication fixture for reusable sign in/out logic

## Writing New Tests

When adding new e2e tests:

1. **For tests requiring authentication**: Use the `authenticatedPage` fixture
   ```typescript
   test("my authenticated test", async ({ authenticatedPage }) => {
     // Your test code here
   });
   ```

2. **For tests without authentication**: Use the standard `page` fixture
   ```typescript
   test("my public test", async ({ page }) => {
     // Your test code here
   });
   ```

3. **Naming conventions**:
   - Test files should end with `.spec.ts`
   - Use descriptive test names that explain what is being tested
   - Group related tests using `test.describe()`

## Configuration

The Playwright configuration (`playwright.config.ts`) includes:

- **Base URL**: `http://localhost:3000`
- **Test directory**: `./e2e`
- **Browsers**: Chromium, Firefox, and WebKit
- **Web server**: Automatically starts the dev server before tests
- **Trace**: Captures traces on first retry for debugging

## Debugging Failed Tests

When tests fail:

1. **Check the HTML report**: After running tests, a report is generated
   ```bash
   pnpm test:e2e --reporter=html
   npx playwright show-report
   ```

2. **Use UI mode** for interactive debugging:
   ```bash
   pnpm test:e2e:ui
   ```

3. **Debug mode** to step through tests:
   ```bash
   pnpm test:e2e:debug
   ```

4. **Check traces**: Traces are captured on test retry and can be viewed in the HTML report

## Best Practices

1. **Keep tests independent**: Each test should be able to run in isolation
2. **Use fixtures**: Leverage the authentication fixture for DRY code
3. **Wait for elements**: Use Playwright's auto-waiting features instead of hard-coded delays
4. **Use semantic selectors**: Prefer role-based and text-based selectors over CSS selectors
5. **Clean up**: The authentication fixture handles sign out, but ensure other test data is cleaned up

## Troubleshooting

### Tests fail with "VITE_ADMIN_EMAIL and VITE_ADMIN_PASS environment variables must be set"

Ensure your `.env` file contains the required environment variables with valid admin credentials.

### Tests timeout on sign in

Check that:
1. The dev server is running (`pnpm dev`)
2. The admin credentials in `.env` are correct
3. The database is properly set up and migrated

### Sign out fails after test

This is non-blocking and won't fail the test. The fixture catches sign out errors to prevent test failures due to cleanup issues.