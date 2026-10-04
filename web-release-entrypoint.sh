#!/bin/sh
set -eu
. "$(dirname "$0")/remote-settings.sh"
validate_remote_settings
host=${WEB_HOST:-${TAILSCALE_HOST:-}}
if [ -n "$host" ]; then
  WEB_SITE=$host
  HUB_URL=${WEB_HUB_URL:-wss://${host}/ws}
else
  WEB_SITE=http://:80
  HUB_URL=${WEB_HUB_URL:-ws://localhost:${LOOPBACK_PORT:-8080}/ws}
fi
WORKSPACES=${WEB_WORKSPACES:-}
export WEB_SITE HUB_URL WORKSPACES
exec caddy "$@"
