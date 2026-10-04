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

# Share the same alphabets with container startup, so plain Compose is safe too.
case "$0" in
  */*) settings_dir=${0%/*} ;;
  *) settings_dir=. ;;
esac
. "$settings_dir/remote-settings.sh"
validate_remote_settings

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

exec docker compose "$@"
