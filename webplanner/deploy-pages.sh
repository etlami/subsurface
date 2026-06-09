#!/usr/bin/env bash
#
# Publish webplanner/public/ to the gh-pages branch (GitHub Pages serves it at
# https://<user>.github.io/<repo>/). Run after rebuilding the WASM, from the
# repo root or anywhere inside it.
#
# Note: a GitHub Actions workflow (.github/workflows/pages.yml) would auto-deploy
# on every push, but pushing workflow files needs a token with the `workflow`
# scope. This script is the no-extra-scope alternative.

set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO/webplanner/public"
REMOTE="$(git -C "$REPO" remote get-url origin)"

[ -f "$SRC/index.html" ] || { echo "error: $SRC/index.html missing (build first)"; exit 1; }

TMP="$(mktemp -d)"
cp -R "$SRC/." "$TMP"/
touch "$TMP/.nojekyll"
(
	cd "$TMP"
	git init -q
	git checkout -q -b gh-pages
	git add -A
	git -c user.name=deploy -c user.email=deploy@local commit -q -m "Deploy webplanner $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || true)"
	git push -q --force "$REMOTE" gh-pages
)
rm -rf "$TMP"
echo "Deployed to gh-pages. Live in ~1 min."
