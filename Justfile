set export := true

# HikmaHealth monorepo task runner. Recipes are split by domain into
# ./just/*.just and imported into one flat namespace, so a recipe in one file
# may depend on a recipe in another.
#
# Conventions across the imported files:
#   - Env loading uses dotenvx to layer root .env + the app's .env. Shell env
#     wins. Leaf builds (tsc/rescript only) skip it.
#   - `pnpm install --filter "<pkg>..."` pulls a deploy app's dependency
#     closure only, so platforms need call just the app's build recipe.
#   - build-hh-forms / build-utils-js emit gitignored .gen.ts / .res.mjs that
#     server + mobile resolve, so they precede those apps' recipes.

import 'just/packages.just'
import 'just/server.just'
import 'just/aiproxy.just'
import 'just/mobile.just'
import 'just/local-hub.just'
import 'just/vendor.just'
import 'just/moon-legacy.just'


# Aggregators — fan out across domains.

build-packages: build-utils-js build-database build-ui build-hh-forms

build-apps: build-server build-aiproxy typecheck-mobile

build-all: build-packages build-apps

# Excludes `test-local-hub-backend` — see just/local-hub.just.
test-all: test-server test-aiproxy test-local-hub-frontend test-mobile


 # ---- App runs ----
 # start-server runs three steps in order, every start, regardless of platform:
 #   1. migrate    — idempotent; brings schema to current
 #   2. recovery   — user_permissions_recovery script; antifragility for permissions/access
 #   3. start-only — boots the built server from .output/
 # Failure at any step aborts boot loudly (set -euo pipefail).
 # Build before starting (just build-server / just build-aiproxy).

create-database:
    #!/usr/bin/env bash
    set -euo pipefail
    ENV_ARGS="-f .env"
    pnpm exec dotenvx run $ENV_ARGS -c 'createdb $DB_NAME -U $DB_USER -h $DB_HOST -p $DB_PORT'

 start-server:
     #!/usr/bin/env bash
     set -euo pipefail
     ENV_ARGS="-f .env"
     [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
     pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter @hikmahealth/database run migrate-latest
     pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run recovery-permissions
     pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run start-only

 start-aiproxy:
     #!/usr/bin/env bash
     set -euo pipefail
     ENV_ARGS="-f .env"
     [ -f apps/aiproxy/.env ] && ENV_ARGS="$ENV_ARGS -f apps/aiproxy/.env"
     pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hh-ai-proxy run start

 # Server in dev mode — vite's dev server (HMR, source maps) instead of the
 # built .output/. Differences from start-server:
 #   - Skips recovery-permissions (prod hardening; nothing to gain in dev).
 #   - One-shot res:build inline so ReScript sources are importable. For
 #     ReScript HMR, run `pnpm --filter hikma-health-server run res:dev` in
 #     a second terminal alongside this.
 # Migrations still run (idempotent; schema must be current to start).
 # build-utils-js / build-database deps mirror test-server — vite needs the
 # workspace builds present to resolve imports.

 dev-server: build-utils-js build-database build-hh-forms
     #!/usr/bin/env bash
     set -euo pipefail
     ENV_ARGS="-f .env"
     [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
     pnpm --filter hikma-health-server run res:build
     pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter @hikmahealth/database run migrate-latest
     pnpm exec dotenvx run $ENV_ARGS -- pnpm --filter hikma-health-server run dev

 # Mobile dev runs — Expo's run:android / run:ios builds the native app, installs
 # on connected device/emulator, and starts Metro. Depends on build-utils-js so
 # .gen.ts files exist before Metro resolves @hikmahealth/js-utils.
 # Assumes pnpm install has been run for the workspace.
 #
 # start-mobile-android accepts an optional mode argument:
 #   `just start-mobile-android`        → debug variant (default, dev client + Metro)
 #   `just start-mobile-android prod`   → release variant (bundled JS, minified,
 #                                         no fast refresh) — for on-device perf
 #                                         testing in real-world conditions.

 start-mobile-android mode='dev': build-utils-js build-hh-forms
     #!/usr/bin/env bash
     set -euo pipefail
     case "{{ mode }}" in
       prod|production|release)
         pnpm --filter hikma-health-mobile run android -- --variant release ;;
       dev|debug)
         pnpm --filter hikma-health-mobile run android ;;
       *)
         echo "start-mobile-android: unknown mode '{{ mode }}' (use 'dev' or 'prod')" >&2
         exit 2 ;;
     esac

 start-mobile-ios mode='dev': build-utils-js build-hh-forms
     #!/usr/bin/env bash
     set -euo pipefail
     case "{{ mode }}" in
       prod|production|release)
         pnpm --filter hikma-health-mobile run ios -- --configuration Release ;;
       dev|debug)
         pnpm --filter hikma-health-mobile run ios ;;
       *)
         echo "start-mobile-ios: unknown mode '{{ mode }}' (use 'dev' or 'prod')" >&2
         exit 2 ;;
     esac



 # ---- Cleanup Scripts : remove artifacts, or just empty accumulating gunk ----

 clean-utils-js:
     pnpm --filter @hikmahealth/js-utils run clean

 clean-database:
     rm -rf database/dist

 clean-ui:
     rm -rf packages/ui/dist

 clean-server:
     rm -rf apps/server/.output
     pnpm --filter hikma-health-server run res:clean

 clean-aiproxy:
     rm -rf apps/aiproxy/dist
     pnpm --filter hh-ai-proxy run res:clean

clean-all: clean-utils-js clean-database clean-ui clean-server clean-aiproxy


# Test data — see database/seed/README.md.

# `db` is the name of the database to write to and is required: it must match
# the database the resolved DATABASE_URL lands on, or the seeder refuses. This
# writes tens of thousands of rows and has no undo, so the target is never
# inherited silently. Extra flags pass through, e.g.
#   just seed-database hhdb_local 5000 --dry-run
#   just seed-database hhdb_local 5000 --seed=42

# Fill a database with synthetic patients and every related table.
seed-database db patients='2000' *args='':
    #!/usr/bin/env bash
    set -euo pipefail
    ENV_ARGS="-f .env"
    [ -f apps/server/.env ] && ENV_ARGS="$ENV_ARGS -f apps/server/.env"
    pnpm exec dotenvx run $ENV_ARGS -- pnpm exec tsx database/seed/seed.ts \
        --allow-database={{ db }} --patients={{ patients }} {{ args }}
