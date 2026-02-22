#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

set -a
if [ -f "$PROJECT_ROOT/docker/.env" ]; then
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/docker/.env"
fi
if [ -f "$PROJECT_ROOT/.env" ]; then
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env"
fi
set +a

exec "$@"
