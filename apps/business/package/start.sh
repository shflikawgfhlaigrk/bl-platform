#!/usr/bin/env bash
set -euo pipefail
BLACKLABEL_PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$BLACKLABEL_PACKAGE_DIR/runtime/bin/node" "$BLACKLABEL_PACKAGE_DIR/server.mjs" "$@"
