# Server — install / build / run / dev / test / clean.

install-server:
    pnpm install --filter "hikma-health-server..."

# Build the server against an already-installed tree. Backs the
# `server:build` npm script, which is what deploy platforms (render.yaml,
# .do/*.yaml) call after their own `pnpm install` — a second install here
# would rewrite node_modules underneath the live `pnpm run` → `just` process
# tree that is executing out of it. Reaching this recipe at all means an
# install already happened: `just` itself comes from the root `rust-just`
# devDependency.

# Build the server. Assumes dependencies are already installed.
build-server-only: build-utils-js build-database build-hh-forms
    #!/usr/bin/env bash
    set -euo pipefail
    ENV_ARGS="-f .env"
    [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run build

# Install then build — the local entry point.
build-server: install-server build-server-only

# Runs migrate → recovery-permissions → setup-token → start-only on every
# start, on every platform. Migrate is idempotent; failure at any step aborts
# boot loudly.
# Requires a prior `just build-server` — this boots the built .output/.

# Boot the built server. Pass a port to override PORT from .env (default: Nitro's 3000).
start-server port='':
    #!/usr/bin/env bash
    set -euo pipefail
    ENV_ARGS="-f .env"
    [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
    # An exported PORT wins over .env, so setting it only when an arg was
    # passed leaves the default path untouched.
    [ -n "{{ port }}" ] && export PORT="{{ port }}"
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter @hikmahealth/database run migrate-latest
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run recovery-permissions
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run setup-token
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run start-only

# No effect once setup is complete or when SETUP_TOKEN is set (change it to rotate).

# Discard the generated first-run setup token and print a new one.
setup-token-reset:
    #!/usr/bin/env bash
    set -euo pipefail
    ENV_ARGS="-f .env"
    [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run setup-token -- --reset

# Differs from start-server: skips recovery-permissions (prod hardening), and
# runs a one-shot res:build so ReScript sources are importable — for ReScript
# HMR run `pnpm --filter hikma-health-server run res:dev` alongside this.
# Migrations still run; the schema must be current to start.

# Server in dev mode — vite dev server with HMR instead of the built .output/.
dev-server: build-utils-js build-database build-hh-forms
    #!/usr/bin/env bash
    set -euo pipefail
    ENV_ARGS="-f .env"
    [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
    pnpm --filter hikma-health-server run res:build
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter @hikmahealth/database run migrate-latest
    pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run dev

test-server: build-utils-js build-database build-hh-forms
    pnpm --filter hikma-health-server run test

clean-server:
    rm -rf apps/server/.output
    pnpm --filter hikma-health-server run res:clean
