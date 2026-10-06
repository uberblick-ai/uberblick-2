#!/bin/sh

set -eu

# An old checkout updater can reach this wrapper after resetting to a release-
# only revision. Refuse before Docker can discover a parent's Compose file or
# use COMPOSE_FILE to mutate an unrelated stack.
if [ ! -f release.json ]; then
  printf 'Hub checkout deployments are no longer supported. Switch this host to a published release using REMOTE.md before updating.\n' >&2
  exit 1
fi

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
. "$settings_dir/../remote-settings.sh"
validate_remote_settings

# Route selection uses the operator's .env. Passing a different env file only
# to Compose would give the containers settings for a route we did not select.
for argument in "$@"; do
  case "$argument" in
    --env-file | --env-file=*)
      printf 'Released hub wrapper does not support --env-file; put settings in .env, or use plain Compose with the route files in REMOTE.md.\n' >&2
      exit 1
      ;;
  esac
done

compose_version=$(docker compose version --short)
compose_version=${compose_version#v}
compose_major=${compose_version%%.*}
compose_remainder=${compose_version#*.}
compose_minor=${compose_remainder%%.*}
compose_patch=${compose_remainder#*.}
compose_patch=${compose_patch%%[-+]*}

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

case "$compose_patch" in
  '' | *[!0-9]*) printf 'Cannot parse Docker Compose version.\n' >&2; exit 1 ;;
esac
if [ "$compose_major" -eq 2 ] && { [ "$compose_minor" -lt 24 ] || { [ "$compose_minor" -eq 24 ] && [ "$compose_patch" -lt 4 ]; }; }; then
  printf 'Docker Compose 2.24.4 or newer is required for released hubs.\n' >&2
  exit 1
fi
host=${WEB_HOST:-${TAILSCALE_HOST:-}}
if [ -z "$host" ]; then
  # Docker before 28 can expose loopback-published ports on the local network.
  # Only startup needs the daemon; config and offline inspection still work.
  for argument in "$@"; do
    if [ "$argument" = up ] || [ "$argument" = start ] || [ "$argument" = create ]; then
      engine_version=$(docker version --format '{{.Server.Version}}')
      engine_major=${engine_version%%.*}
      case "$engine_major" in
        '' | *[!0-9]*) printf 'Cannot parse Docker Engine version.\n' >&2; exit 1 ;;
      esac
      if [ "$engine_major" -lt 28 ]; then
        printf 'Docker Engine 28.0.0 or newer is required for host-only HTTP publication.\n' >&2
        exit 1
      fi
      break
    fi
  done
fi
# Select ordinary release override files without changing the project name.
if [ -z "${COMPOSE_FILE-}" ]; then
  case "$host" in
    *.[tT][sS].[nN][eE][tT]) set -- -f docker-compose.yml -f remote.https.yml -f remote.tailscale.yml "$@" ;;
    '') set -- -f docker-compose.yml "$@" ;;
    *) set -- -f docker-compose.yml -f remote.https.yml "$@" ;;
  esac
fi

exec docker compose "$@"
