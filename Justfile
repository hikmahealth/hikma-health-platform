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
