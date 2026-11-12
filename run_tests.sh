#!/usr/bin/env bash
# Run the SQLLogic (haybarn) suite in test/sql/ against the TypeScript worker, using the
# haybarn DuckDB distribution's unittest runner (which loads the `vgi` extension from the
# community repository).
#
# Prerequisites (one-time):
#   uv tool install --prerelease allow 'haybarn-unittest>=2.0.0rc11,<2.1'  # the DuckDB unittest binary
#   echo "INSTALL vgi FROM community;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli  # install the vgi extension
#   bun install                                           # the worker's deps
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

UNITTEST="${VGI_UNITTEST:-$(command -v haybarn-unittest || true)}"
if [[ -z "$UNITTEST" || ! -x "$UNITTEST" ]]; then
    echo "ERROR: haybarn-unittest not found. Install it with:" >&2
    echo "       uv tool install --prerelease allow 'haybarn-unittest>=2.0.0rc11,<2.1'" >&2
    exit 1
fi

# Ensure the vgi community extension is installed for this haybarn version. (haybarn 2.0 /
# vgi.v3: the community extension must speak protocol 3.3.)
if ! echo "LOAD vgi;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli >/dev/null 2>&1; then
    echo "==> Installing vgi extension from community repository"
    echo "INSTALL vgi FROM community;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli
fi

# NOTE: the last arg is a Catch2 test-name filter, not a shell glob. Catch2 only honors a
# trailing `*` wildcard, so use `test/sql/*` (not `test/sql/*.test`).
WORKER="$REPO_ROOT/bin/vgi-etf-ishares-worker"
TEST_GLOB="${1:-test/sql/*}"

echo "==> Running SQLLogic tests"
echo "    worker:   $WORKER"
echo "    unittest: $UNITTEST"
echo "    tests:    $TEST_GLOB"

# --keep-home: haybarn-unittest 2.0 isolates $HOME, hiding the installed vgi extension.
VGI_TEST_WORKER="$WORKER" \
VGI_WORKER_CATALOG_NAME="ishares" \
    "$UNITTEST" --keep-home --test-dir "$REPO_ROOT" "$TEST_GLOB"
