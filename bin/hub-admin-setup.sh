#!/bin/sh
# Run the host-only first-administrator command in the running hub container.
# The command talks to the hub's private Unix socket; it never opens SQLite.
set -eu

usage() {
  printf 'usage: sh bin/hub-admin-setup.sh <workspace-uuid>\n       sh bin/hub-admin-setup.sh status <setup-uuid>\n'
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

checkout=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$checkout"

# Compose exec does not forward host signals. With terminal input, use its
# container TTY so Ctrl-C reaches the command and it can report cancellation.
set -- hub packages/hub/node_modules/.bin/tsx packages/hub/src/admin-setup-command.ts "$@"
if [ -t 0 ]; then
  exec sh bin/remote-compose.sh exec "$@"
fi
exec sh bin/remote-compose.sh exec -T "$@"
