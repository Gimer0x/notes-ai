#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

echo "== backend =="
(cd "$root/backend" && npm test && npm run typecheck)

echo "== website =="
(cd "$root/website" && npm test && npm run typecheck)

echo "== frontend =="
(cd "$root/frontend" && npm run typecheck)

echo "All tests passed."
