#!/bin/sh
# Run the host-only first-administrator command in the running hub container.
# The command talks to the hub's private Unix socket; it never opens SQLite.
set -eu

usage() {
  printf 'usage: sh hub-admin-setup.sh <workspace-uuid>\n       sh hub-admin-setup.sh status <setup-uuid>\n'
}

case "${1-}" in
  -h | --help)
    usage
    exit 0
    ;;
  status)
    if [ $# -ne 2 ]; then usage >&2; exit 2; fi
    ;;
  *)
    if [ $# -ne 1 ]; then usage >&2; exit 2; fi
    ;;
esac

checkout=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$checkout"

# Keep the deployment's configuration gate and replace the shell so its
# signals are not swallowed by an extra wrapper process.
exec sh remote-compose.sh exec -T hub \
  packages/hub/node_modules/.bin/tsx packages/hub/src/admin-setup-command.ts "$@"
