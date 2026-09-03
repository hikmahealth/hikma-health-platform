import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
// import viteTsConfigPaths from "vite-tsconfig-paths";
import { devtools } from "@tanstack/devtools-vite";
import { nitro } from "nitro/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import tailwindcss from "@tailwindcss/vite";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import { resolve } from "path";

// import { wrapVinxiConfigWithSentry } from "@sentry/tanstackstart-react";
import viteReact from "@vitejs/plugin-react";

// `@hikmahealth/forms` ReScript output imports the vendored JSONLogic
// engine via deep paths (`@nd/jsonlogic/src/JsonLogic.res.mjs`). The
// vendored package's exports map only exposes the root, so Vite's strict
// exports resolution rejects the deep import without this alias. The
// vendor package is off-limits to edit (a fix exists upstream).
const vendoredJsonLogic = resolve(__dirname, "../../vendor/@nd/jsonlogic");

export default defineConfig({
  // plugins: [
  //   // this is the plugin that enables path aliases
  //   viteTsConfigPaths({
  //     projects: ["./tsconfig.json"],
  //   }),
  //   tailwindcss(),
  //   tanstackStart(),
  // ],
  plugins: [
    devtools(),
    nitro({
      builder: "rolldown",
      rolldownConfig: {
        // rollupConfig: {
        external: [
          /^@sentry\//,
          "exceljs",
          /^echarts/,
          "zrender",
          "jsdom",
          "isomorphic-dompurify",
        ],
      },
      // preset: "render_com",
    }),
    // nitro(),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    sentryTanstackStart({
      org: process.env.VITE_SENTRY_ORG,
      project: process.env.VITE_SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
    }),
  ],
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: [
      {
        find: /^@nd\/jsonlogic\/(.*)$/,
        replacement: `${vendoredJsonLogic}/$1`,
      },
    ],
  },
  server: {
    allowedHosts: ["localhost", ".ngrok.io", ".ngrok-free.app"],
  },
});
