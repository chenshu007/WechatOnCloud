#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --prefix panel/server --no-audit --no-fund
npm ci --prefix panel/web --no-audit --no-fund
panel/server/node_modules/.bin/tsc --noEmit -p panel/server
panel/web/node_modules/.bin/tsc --noEmit -p panel/web
node --import ./panel/server/node_modules/tsx/dist/loader.mjs --test tests/*.test.ts
python3 -m unittest discover -s tests -p '*_test.py'
# Icons are already tracked; do not regenerate PNGs with host-dependent zlib.
(cd panel/web && ./node_modules/.bin/vite build)
bash -n docker/autostart docker/app-defs.sh docker/app-ctl.sh docker/woc-app-init.sh scripts/*.sh
git diff --check
