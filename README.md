# Hikma Health Stack

A full-stack, offline-first electronic health record platform designed for
organizations working in low-resource settings. Hikma Health supports thousands
of patients, multiple languages (including RTL), and resilient sync between
field devices and a central server.

This repository is a **pnpm monorepo** that consolidates what used to live in
several separate repositories (mobile, server, admin, AI proxy). The codebase 
utilizes TypeScript, ReScript and Rust across different platforms and tooling. 
The databases used for persistance are SQLite (either barebones SQLite v3, or through WatermelonDB) 
and PostgreSQL.

## Deploy the server

The buttons below provision a fresh **server** deployment. The mobile app is
distributed through the App Store and Play Store, not via these buttons.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new)

If you are migrating from the legacy `hikma-health-backend` (Python/Flask) +
`hikma-health-admin` (Next.js) repos, see the migration notes in
[`apps/server/README.md`](apps/server/README.md) — your existing PostgreSQL
database is reused, and migrations run automatically on startup.




---

<details>
<summary><strong>Migrating from a previous (<code>main</code>-based) deployment</strong></summary>

**This repository is the next evolution of the Hikma Health platform.** What used to live across several repositories now lives here, on the new default branch **`v3`**:

- `hikma-health-server` — previously the contents of this repo's `main` branch, now in [`apps/server/`](apps/server/)
- `hikma-health-mobile` — React Native app, now in [`apps/mobile/`](apps/mobile/)
- `hikma-health-ai-proxy` — air-gapping LLM proxy, now in [`apps/aiproxy/`](apps/aiproxy/)
- `hikma-health-local-hub` — Tauri desktop hub, now in [`apps/local-hub/`](apps/local-hub/)

`main` will continue to exist for a transitional period but **will no longer receive updates**. All future fixes, features, and security patches ship on `v3`. To keep getting updates, you need to migrate your deployment(s) to track `v3`.

> **Heads up:** your PostgreSQL data is **not** touched by this migration. The new server uses the same `DATABASE_URL` and runs idempotent Kysely migrations on startup, so the schema is brought forward automatically the first time the v3 build boots.

### If you deployed the server to Render (most common case)

You almost certainly clicked the **Deploy to Render** button at some point — that linked your Render service either to a fork of this repo or directly to the upstream repo, on the `main` branch. You need to repoint it at `v3`.

#### 1. Decide whether to keep using a fork

- **No fork (deployed straight from this repo, or you don't need custom changes):** skip ahead to step 2. You'll point Render directly at `hikmahealth/hikma-health-platform@v3`.
- **You have a fork with custom changes on `main`:** sync your fork's default branch from upstream's `v3`, then either rebase your customizations on top of `v3` or recreate them as a `v3`-based branch on your fork. Note that the codebase has reorganized into a monorepo, so any patches against `apps/server/` paths will need to be re-applied at `apps/server/...` instead of the old top-level `src/`.
- **Forks of `hikma-health-mobile`, `hikma-health-ai-proxy`, or `hikma-health-local-hub`:** archive them. Going forward, contribute and pull from this monorepo. Those standalone repos are frozen.

#### 2. Repoint your Render web service at the `v3` branch

You can do this in either of two ways:

**Option A — Update the existing service's branch in the dashboard.** Open your `hikma-health-server` web service in the Render dashboard → **Settings** → **Build & Deploy** → change the branch from `main` to `v3` and save. Render will trigger a new deploy. Because the `v3` branch ships an updated [`render.yaml`](render.yaml), the build and start commands (`pnpm install --filter "hikma-health-server..." && pnpm run server:build` / `pnpm run server:start`) will sync automatically on the next Blueprint sync. ([Render — change branch on existing Blueprints](https://x.com/render/status/1846615518184460705))

**Option B — Re-deploy the Blueprint.** Click the **Deploy to Render** button at the top of this README again. Render will detect the existing `hikma-health-server` service and `hikma-health-db` database by name and apply the v3 Blueprint configuration to them in place; secrets and environment variables marked `sync: false` are preserved. ([Render — Blueprints / IaC docs](https://render.com/docs/infrastructure-as-code))

In both cases, the database service is reused — `DATABASE_URL` is wired through `fromDatabase` in `render.yaml`, so the existing `hikma-health-db` keeps its data.

#### 3. Verify the deployment

- Watch the build logs for a successful `pnpm run server:build`.
- On boot, confirm Kysely migrations and the `user_permissions_recovery` script ran without errors.
- Hit the admin web app and log in. The server is healthy when the admin shell loads and the database is reachable.
- **Mobile users will need to sign out and re-scan the QR code** to pick up the new server build.

#### 4. (Optional) AI proxy

If you previously deployed the AI proxy as a separate service, apply [`aiproxy.render.yaml`](aiproxy.render.yaml) as a second Blueprint after the server is healthy. It is intentionally a separate Blueprint so the server can stand on its own.

### If you deployed somewhere other than Render

The story is the same in shape: point your build to the `v3` branch, install with `pnpm`, and run `pnpm run server:build` followed by `pnpm run server:start`. See the [Running apps from the monorepo root](#running-apps-from-the-monorepo-root) section for the canonical commands and [`apps/server/README.md`](apps/server/README.md) for environment variables.

### If something goes wrong

Open a GitHub issue with your deploy logs (redact any secrets), or email `ally[at]hikmahealth.org`. The migration is designed to be reversible — your old `main`-based deployment is untouched until you switch the branch, so you can always revert the branch in Render Settings while we sort it out.

</details>

---



## Repository layout

```
hikma-health-platform/
├── apps/
│   ├── server/        # TanStack Start full-stack server + admin web app
│   ├── mobile/        # Expo / React Native app (iOS + Android)
│   ├── aiproxy/       # Air-gapping proxy between servers and 3rd-party LLMs
│   └── local-hub/     # Tauri desktop companion app
├── packages/
│   ├── ui/            # Shared web UI components
│   ├── client-native/ # Shared native (RN) primitives
│   ├── common/        # Cross-cutting domain logic
│   ├── data/          # Shared data-layer helpers
│   ├── hh-forms/      # Form definitions and runtime
│   ├── utils/js/      # Shared TS/ReScript utilities (@hikmahealth/js-utils)
│   ├── utils/rust/    # Rust utilities (future cross-language work)
│   ├── eslint-config/
│   └── typescript-config/
├── database/          # Kysely migrations and generated DB types
├── docs/              # Engineering docs
├── Justfile           # Build/run recipes invoked by the pnpm scripts
├── package.json       # Workspace root + top-level run scripts
└── pnpm-workspace.yaml
```

App-specific documentation:

- [`apps/server/README.md`](apps/server/README.md) — server stack, env vars,
  available commands, security notes
- [`apps/mobile/README.md`](apps/mobile/README.md) — Expo setup, EAS builds,
  Maestro E2E, language packs
- [`apps/aiproxy/README.md`](apps/aiproxy/README.md) — AI proxy purpose
- [`apps/local-hub/README.md`](apps/local-hub/README.md) — desktop hub

## Tech stack at a glance

- **Language**: TypeScript (primary), ReScript, Rust
- **Server**: TanStack Start, Kysely, PostgreSQL
- **Mobile**: Expo SDK 53, React Native 0.79, WatermelonDB, XState
- **Web UI**: Tailwind CSS 4, Radix UI / shadcn/ui
- **Tooling**: pnpm workspaces, Just (recipes), oxlint, Biome, Vitest,
  Playwright, Maestro, Sentry

## Prerequisites

- **Node.js 24.14.0** — [nodejs.org](https://nodejs.org/)
- **pnpm ≥ 10.28.1** — `npm install -g pnpm`
- **Just** — installed automatically via the `rust-just` dev dependency, or
  `brew install just`
- **PostgreSQL** — local, Docker, or a hosted instance (Render, DigitalOcean,
  Supabase, etc.) — required for the server
- **Expo / React Native toolchain** — required for the mobile app
  ([setup guide](https://docs.expo.dev/get-started/installation/))

## Getting started

```bash
git clone git@github.com:hikmahealth/hikma-health-platform.git
cd hikma-health-platform
pnpm install
```

Each app reads its own `.env`. At minimum:

- `apps/server/.env` — `DATABASE_URL=postgresql://user:pass@host:port/db`
  - **Database TLS** is required in production. Pick a mode by appending
    `?sslmode=…` to `DATABASE_URL` (preferred) or by setting `DB_SSLMODE` as a
    fallback. Valid modes: `disable`, `require`, `verify-ca`, `verify-full`.
    `verify-full` is the recommended default for any non-loopback host and is
    needed to satisfy HIPAA §164.312(e)(1).
    - For providers whose chain isn't in the system trust store (e.g. Render's
      internal Postgres, self-hosted PG with a private CA), paste the PEM body
      into `DATABASE_CA_CERT`. Literal `\n` escapes from shell `export` are
      normalized automatically.
    - Localhost connections (`localhost` / `127.0.0.1` / `::1`) default to
      `disable` so local dev "just works".
    - Production deployments without an explicit `sslmode` log a deprecation
      warning at boot and fall back to `require` (encrypt only, no
      certificate verification). This fallback is removed in the next major
      release; after that, production with no `sslmode` will fail-closed.
    - Render: external Postgres works with `?sslmode=verify-full` and no
      extra cert (system trust store covers it). Internal Postgres should
      use `?sslmode=verify-full` with Render's internal CA pasted into
      `DATABASE_CA_CERT`, or `?sslmode=require` if you accept no
      verification across Render's private network.
  - Optional pool tuning: `DB_POOL_MAX` (default `20`, hard ceiling `200`),
    `DB_STATEMENT_TIMEOUT_MS` (default `60000`). See
    [`apps/server/README.md`](apps/server/README.md#database-connection-pool-tuning)
    for when and how to adjust.
- `apps/mobile/.env` — `EXPO_PUBLIC_HIKMA_API_TESTING=<your-server-url>`
- `apps/aiproxy/.env` — see [`apps/aiproxy/README.md`](apps/aiproxy/README.md)

Never commit `.env` files. They are gitignored by default.

## Running apps from the monorepo root

The root [`package.json`](package.json) exposes thin wrappers around the
`Justfile` recipes so you can drive every app with `pnpm` from one place. Each
script targets a single app's dependency closure — unrelated apps are skipped.

### Server

```bash
pnpm run server:install-build  # install deps + build the server (and its workspace deps)
pnpm run server:build          # build only — assumes deps are already installed
pnpm run server:start          # run migrations, recovery, then start the built server
```

`server:build` deliberately does not install: deploy platforms run their own
`pnpm install` first, and a second one would rewrite `node_modules` underneath
the running build. Use `server:install-build` (or `just build-server`) locally
when you also want the install.

The `start` recipe runs idempotent Kysely migrations and the
`user_permissions_recovery` script before booting, so a single command is
enough to bring a deployment to a current, healthy state.

### Mobile

```bash
pnpm run mobile:start-android    # build native, install, launch Metro for Android
pnpm run mobile:start-ios        # same for iOS
```

These wrap `expo run:android` / `expo run:ios` and ensure the shared JS
utilities (`@hikmahealth/js-utils`) are built first so Metro can resolve them.
For EAS builds, OTA updates, and Maestro E2E, see
[`apps/mobile/README.md`](apps/mobile/README.md).

### AI Proxy

```bash
pnpm run aiproxy:build
pnpm run aiproxy:start
```

### Linting

```bash
pnpm run lint
pnpm run lint:fix
```

App-specific scripts (tests, formatters, dev servers with hot reload, etc.)
live in each app's own `package.json` and are documented in that app's README.
You can call them directly with pnpm filters, e.g.:

```bash
pnpm --filter hikma-health-server run dev
pnpm --filter hikma-health-server run test
pnpm --filter hikma-health-mobile run test:maestro
```

## Security and compliance

This codebase handles protected health information. Treat it accordingly:

- Never commit secrets, credentials, or PHI
- TLS with certificate verification is required for remote database
  connections in production — use `sslmode=verify-full` in `DATABASE_URL`
  (or `DB_SSLMODE`), and supply `DATABASE_CA_CERT` if your provider's chain
  isn't publicly trusted. See the env-vars list above for the full set
- Keep dependencies current (`pnpm update`, `pnpm audit`)
- Follow HIPAA and any local healthcare data regulations applicable to your
  deployment
- Report vulnerabilities privately to the maintainer rather than opening a
  public issue


## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) where present, plus the per-app
guidelines. In short:

- Code must pass `pnpm run lint`
- App-specific tests and type checks must pass before opening a PR
- Commit messages should be clear and descriptive

## Support

For questions, open a GitHub issue or email the maintainer at
`ally[at]hikmahealth.org`.

## License

[MIT](https://choosealicense.com/licenses/mit/)
