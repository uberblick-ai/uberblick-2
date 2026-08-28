#!/bin/sh

set -eu

compose_version=$(docker compose version --short)
compose_version=${compose_version#v}
compose_major=${compose_version%%.*}
compose_remainder=${compose_version#*.}
compose_minor=${compose_remainder%%.*}

case "$compose_major.$compose_minor" in
  *[!0-9.]* | .* | *.)
    printf 'Cannot parse Docker Compose version: %s\n' "$compose_version" >&2
    exit 1
    ;;
esac

if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt 6 ]; }; then
  printf 'Docker Compose 2.6.0 or newer is required; found %s\n' "$compose_version" >&2
  exit 1
fi

if [ -f .env ]; then
  set -a
  # The deployment .env is trusted operator-owned configuration.
  . ./.env
  set +a
fi

: "${HUB_AUTH_TOKEN:?set HUB_AUTH_TOKEN in .env}"

# The alphabet is now load-bearing twice over. Compose and the shell parse other
# characters differently, so the deployed secret could silently diverge from the
# one MCP clients use — and since #426 the secret is also substituted *inside*
# the JSON string Caddy responds with, where a quote or a backslash would close
# that string and append further keys, exactly as it would for WEB_WORKSPACES
# below.
case "$HUB_AUTH_TOKEN" in
  *[!A-Za-z0-9._-]*)
    printf 'HUB_AUTH_TOKEN may only contain A-Z a-z 0-9 . _ - : shell and Docker Compose parse other characters differently, so the deployed secret could silently diverge from the one MCP clients use, and it is substituted into the JSON configuration document Caddy serves, where a quote or a backslash would let the value inject further keys. Regenerate the secret with safe characters.\n' >&2
    exit 1
    ;;
esac

# WEB_WORKSPACES is substituted *inside* the JSON string Caddy responds with
# (see the Caddyfile), so a quote or a backslash in it does not merely produce a
# malformed document: it closes the string and appends whatever follows as
# further JSON. A second `hubUrl` key added that way wins, and the browser dials
# the hub it names. Workspace ids are uuids, optionally slug-decorated, so the
# character set that can express every legitimate value has no quoting in it at
# all — and refusing the rest here is what keeps that injection impossible
# rather than merely unlikely.
case "${WEB_WORKSPACES-}" in
  *[!A-Za-z0-9,-]*)
    printf 'WEB_WORKSPACES may only contain A-Z a-z 0-9 , - : it is substituted into the JSON configuration document Caddy serves, where a quote or a backslash would let the value inject further keys — including one that retargets the browser at another hub. A workspace id is a uuid, optionally prefixed with a display slug.\n' >&2
    exit 1
    ;;
esac

# The checked copy, and the only variable this script sets. `docker-compose.yml`
# gates Caddy's secret on this name with `:?`, so a bare `docker compose up` —
# which would read HUB_AUTH_TOKEN straight out of `.env` and skip every check
# above — fails instead of serving an unchecked value into the Caddyfile's raw
# JSON. It is exported rather than passed so the value never reaches a command
# line, an argument list or a shell history.
CHECKED_HUB_AUTH_TOKEN=$HUB_AUTH_TOKEN
export CHECKED_HUB_AUTH_TOKEN

exec docker compose "$@"
