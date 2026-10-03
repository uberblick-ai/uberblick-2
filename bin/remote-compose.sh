#!/bin/sh

set -eu

# Every value the served configuration document carries is checked here, and
# checked *before* the first `docker` call: a refusal is then about the value
# and never about the daemon, and a host without Docker still gets the honest
# message.
#
# The Caddyfile substitutes all of them *inside* the JSON string it responds
# with, so a quote or a backslash in any one does not merely produce a malformed
# document: it closes the string and appends whatever follows as further JSON. A
# second `hubUrl` key added that way wins on parse, and every browser dials the
# hub it names. Refusing the characters that could do it is what makes that
# impossible rather than merely unlikely — the client's own duplicate-key check
# is defence in depth behind this, not the guarantee.
if [ -f .env ]; then
  set -a
  # The deployment .env is trusted operator-owned configuration.
  . ./.env
  set +a
fi

: "${HUB_AUTH_TOKEN:?set HUB_AUTH_TOKEN in .env}"

# The secret's alphabet is load-bearing twice over. Compose and the shell parse
# other characters differently, so the deployed secret could silently diverge
# from the one MCP clients use — and since #426 it is substituted into the
# document as well.
case "$HUB_AUTH_TOKEN" in
  *[!A-Za-z0-9._-]*)
    printf 'HUB_AUTH_TOKEN may only contain A-Z a-z 0-9 . _ - : shell and Docker Compose parse other characters differently, so the deployed secret could silently diverge from the one MCP clients use, and it is substituted into the JSON configuration document Caddy serves, where a quote or a backslash would let the value inject further keys. Regenerate the secret with safe characters.\n' >&2
    exit 1
    ;;
esac

# Workspace ids are uuids, optionally slug-decorated, so the character set that
# can express every legitimate value has no quoting in it at all.
case "${WEB_WORKSPACES-}" in
  *[!A-Za-z0-9,-]*)
    printf 'WEB_WORKSPACES may only contain A-Z a-z 0-9 , - : it is substituted into the JSON configuration document Caddy serves, where a quote or a backslash would let the value inject further keys — including one that retargets the browser at another hub. A workspace id is a uuid, optionally prefixed with a display slug.\n' >&2
    exit 1
    ;;
esac

# The endpoint reaches that same document by either route: `WEB_HUB_URL` when an
# operator sets one, and `TAILSCALE_HOST` through the `wss://<host>/ws` default
# compose builds from it — which is also the Caddy site address. A ws(s) address
# needs no quoting and a MagicDNS name is letters, digits, dots and hyphens, so
# both alphabets can express every legitimate value.
case "${WEB_HUB_URL-}" in
  *[!A-Za-z0-9:/._-]*)
    printf 'WEB_HUB_URL may only contain A-Z a-z 0-9 : / . _ - : it is substituted into the JSON configuration document Caddy serves, where a quote, a backslash or whitespace would let the value inject further keys — including a second hubUrl that retargets every browser. It is a plain ws:// or wss:// address, which needs none of them.\n' >&2
    exit 1
    ;;
esac

case "${TAILSCALE_HOST-}" in
  *[!A-Za-z0-9.-]*)
    printf 'TAILSCALE_HOST may only contain A-Z a-z 0-9 . - : it is the Caddy site address and the hub endpoint served in the JSON configuration document, where a quote, a backslash or whitespace would let the value inject further keys. It is the full MagicDNS name, with no scheme and no trailing slash.\n' >&2
    exit 1
    ;;
esac

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

# The checked copy, and the only variable this script sets. `docker-compose.yml`
# gates Caddy's secret on this name with `:?`, so a bare `docker compose up` —
# which would read HUB_AUTH_TOKEN straight out of `.env` and skip every check
# above — fails instead of serving an unchecked value into the Caddyfile's raw
# JSON. It is exported rather than passed so the value never reaches a command
# line, an argument list or a shell history.
CHECKED_HUB_AUTH_TOKEN=$HUB_AUTH_TOKEN
export CHECKED_HUB_AUTH_TOKEN

exec docker compose "$@"
