#!/bin/sh
set -eu
. "$(dirname "$0")/remote-settings.sh"
validate_remote_settings
: "${TAILSCALE_HOST:?set TAILSCALE_HOST in .env}"
HUB_URL=${WEB_HUB_URL:-wss://${TAILSCALE_HOST}/ws}
WORKSPACES=${WEB_WORKSPACES:-}
export HUB_URL WORKSPACES
exec caddy "$@"
