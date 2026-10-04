#!/bin/sh
set -eu
. "$(dirname "$0")/remote-settings.sh"
validate_remote_settings
exec "$@"
