#!/bin/sh
set -eu
. "$(dirname "$0")/remote-settings.sh"
validate_remote_settings
# Compose passes an unset setting as empty; the processes require absence.
if [ "${HUB_PUBLIC_URL:-}" = "" ]; then unset HUB_PUBLIC_URL; fi
exec "$@"
