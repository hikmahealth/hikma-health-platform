import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// `@hikmahealth/forms` is a workspace ReScript package. Its generated
// `.res.mjs` files import the JSONLogic engine via deep paths
// (`@nd/jsonlogic/src/JsonLogic.res.mjs`). The vendored package's exports
// map only exposes the package root, so Vite's strict-exports resolution
// rejects the deep import. The vendor package is off-limits to edit
// (a fix exists upstream), so map the deep path to the vendored file
// directly for the test runner.
const vendoredJsonLogic = resolve(__dirname, "../../vendor/@nd/jsonlogic");

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // The form-builder suites drive hundreds of jsdom renders each, so the 5s
    // default fails them on scheduling rather than on a real bug. Matches
    // vitest.integration.config.ts.
    testTimeout: 30_000,
    setupFiles: ["./tests/setup.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**", "**/tests/integration/**"],
    coverage: {
      reporter: ["text", "json", "json-summary", "html"],
      exclude: [
        "**/node_modules/**",
        "**/test/**",
        "**/tests/**",
        "**/.nitro/**",
        "**/.output/**",
        "**/.tanstack/**",
        "**/public/**",
        "**/dist/**",
        "**/e2e/**",
        "**/src/components/ui/**",
        "**/src/routes/**",
        "**/src/data/**",
        "**/src/routeTree.gen.ts",
        "**/db/migrations/**",
        "**/db/old.*",
        "**/db/alembic-*",
        "**/db/utils.ts",
        "**/scripts/**",
        "**/playwright-report/**",
        "**/lib/bs/**",
        "**/*.config.ts",
        "**/*.d.ts",
      ],
      thresholds: {
        // Ratchet thresholds: raise these as coverage improves. Target: 50%.
        statements: 1,
        branches: 45,
        functions: 19,
        lines: 1,
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "./src") },
      {
        find: /^@nd\/jsonlogic\/(.*)$/,
        replacement: `${vendoredJsonLogic}/$1`,
      },
    ],
  },
});
