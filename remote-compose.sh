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

token_digest=$(printf '%s' "$HUB_AUTH_TOKEN" | sha256sum)
HUB_AUTH_TOKEN_DIGEST=${token_digest%% *}
export HUB_AUTH_TOKEN_DIGEST

exec docker compose "$@"
