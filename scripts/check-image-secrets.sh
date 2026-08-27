#!/usr/bin/env bash
# Assert that a container image discloses no credential.
#
# The published hub image (`ghcr.io/uberblick-ai/uberblick-hub`) is public:
# anyone pulls it with no credential. Its `hub` stage mounts no build secret —
# the only `--mount=type=secret` in the Dockerfile belongs to the web bundle, a
# different target — but `COPY . .` means the image carries the repository
# working tree minus `.dockerignore`'s exclusions. This check is what turns "no
# secret is copied in" from a reading of the Dockerfile into a fact about the
# artefact that is actually published.
#
#   scripts/check-image-secrets.sh <image-ref>
#   scripts/check-image-secrets.sh --self-test
#
# It flattens the image with `docker export` and fails when it finds:
#
#   - a file named `age.txt` (the fnox private key), `credentials.json` (the
#     hub signing secret), `mise.local.toml` or `.mise.local.toml`, or an
#     `.env` in any of its spellings;
#   - an age private key anywhere in the bytes, by its `AGE-SECRET-KEY-`
#     prefix;
#   - the value of `$SECRET_NEEDLE`, when that variable is set, in the flattened
#     filesystem, in the image configuration, or in the build history;
#   - a credential-shaped variable baked into the image configuration.
#
# **What it does not scan: the layer blobs.** `docker export` is the flattened
# final filesystem, so a secret written in one layer and deleted in a later one
# is invisible to it, even though `docker save` would still ship the blob that
# holds it. Scanning blobs means decompressing every layer of a multi-gigabyte
# image and is unreliable besides — a compressed stream does not answer to
# `grep`. The build history is scanned instead, which catches the shape this
# repository could actually produce (a `--build-arg` or an `ENV` carrying a
# value); a deliberately hidden layer secret is out of this check's model, and
# the defence against it is that the Dockerfile mounts no secret at all.
#
# `SECRET_NEEDLE` is how a machine that holds the real signing secret checks for
# that exact value:
#
#   SECRET_NEEDLE="$(fnox get HUB_AUTH_TOKEN)" scripts/check-image-secrets.sh <ref>
#
# It is never printed — not on a pass, not on a failure, not in the line that
# names the rule it broke. CI holds no such secret and runs without it, which is
# why `--self-test` exists: it plants a credential in a throwaway image and
# demands that this same code path rejects it, so a passing check is evidence
# rather than a tautology.
set -euo pipefail

# Assembled from two halves so that this file — which `COPY . .` puts inside
# the very image it inspects — does not itself contain the literal it searches
# for. A check that always fails on its own presence would be worthless.
readonly AGE_KEY_PREFIX="AGE-SECRET-KEY""-1"
readonly CONTAINER="uberblick-secret-check-$$"
readonly SELFTEST_IMAGE="uberblick-secret-check-selftest:$$"

cleanup() {
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  docker image rm --force "$SELFTEST_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# One `docker export` stream per needle. `grep -c` reads the stream to the end,
# so no match can be lost to a SIGPIPE, and the needle itself never reaches a
# log — only the count comes back.
count_in_image() {
  local needle=$1
  docker export "$CONTAINER" | { grep -a -c -F -- "$needle" || true; }
}

# The two places a secret reaches an image without ever being a file: an
# environment value under an innocent name, and a build argument frozen into the
# history of the layer that used it.
count_in_metadata() {
  local image=$1 needle=$2
  {
    docker image inspect "$image"
    docker history --no-trunc --format '{{.CreatedBy}}' "$image"
  } | { grep -a -c -F -- "$needle" || true; }
}

check_image() {
  local image=$1
  local failures=0

  echo "checking $image"
  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true
  # The command is never run: `docker create` only has to make a filesystem to
  # export, which is what lets this work on a `FROM scratch` image too.
  docker create --name "$CONTAINER" "$image" /nonexistent-command-never-run >/dev/null

  local found
  found=$(docker export "$CONTAINER" | tar -t 2>/dev/null |
    { grep -E '(^|/)(\.env(\..*)?|\.?mise\.local\.toml|age\.txt|credentials\.json)$' || true; })
  if [ -n "$found" ]; then
    echo "FAIL: credential files in the image filesystem:"
    printf '%s\n' "$found" | sed 's/^/  /'
    failures=$((failures + 1))
  else
    echo "ok: no age.txt, credentials.json, mise.local.toml or .env, at any depth"
  fi

  if [ "$(count_in_image "$AGE_KEY_PREFIX")" != "0" ]; then
    echo "FAIL: an age private key is present in the image"
    failures=$((failures + 1))
  else
    echo "ok: no age private key"
  fi

  if [ -n "${SECRET_NEEDLE:-}" ]; then
    if [ "$(count_in_image "$SECRET_NEEDLE")" != "0" ]; then
      echo "FAIL: the value of \$SECRET_NEEDLE is present in the image"
      failures=$((failures + 1))
    elif [ "$(count_in_metadata "$image" "$SECRET_NEEDLE")" != "0" ]; then
      echo "FAIL: the value of \$SECRET_NEEDLE is present in the image configuration or build history"
      failures=$((failures + 1))
    else
      echo "ok: the value of \$SECRET_NEEDLE is absent from the filesystem, the configuration and the history"
    fi
  else
    echo "skipped: \$SECRET_NEEDLE is unset, so no specific secret value was searched for"
  fi

  local names
  names=$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
    { grep -oE '^[^=]+=' || true; } | tr -d '=')
  if printf '%s\n' "$names" | grep -qE '(SECRET|TOKEN|PASSWORD|CREDENTIAL)'; then
    echo "FAIL: the image configuration carries a credential-shaped variable:"
    printf '%s\n' "$names" | grep -E '(SECRET|TOKEN|PASSWORD|CREDENTIAL)' | sed 's/^/  /'
    failures=$((failures + 1))
  else
    echo "ok: no credential-shaped variable in the image configuration"
  fi

  docker rm --force "$CONTAINER" >/dev/null 2>&1 || true

  if [ "$failures" -ne 0 ]; then
    echo "$image: $failures check(s) failed"
    return 1
  fi
  echo "$image: clean"
}

# Plants a credential in a one-file image and demands that check_image rejects
# it. `FROM scratch` keeps this instant and offline: what is under test is the
# checking code, not a base image.
self_test() {
  local planted="${AGE_KEY_PREFIX}SELFTESTNOTAREALKEY"
  local dir
  dir=$(mktemp -d)

  printf '%s\n' "$planted" >"$dir/age.txt"
  cat >"$dir/Dockerfile" <<'EOF'
FROM scratch
COPY age.txt /root/.config/fnox/age.txt
ENV API_TOKEN=x
EOF
  docker build --quiet --tag "$SELFTEST_IMAGE" "$dir" >/dev/null
  rm -rf "$dir"

  echo "self-test: a planted credential must be rejected"
  local output status=0
  output=$(SECRET_NEEDLE="$planted" check_image "$SELFTEST_IMAGE" 2>&1) || status=$?

  if [ "$status" -eq 0 ]; then
    echo "SELF-TEST FAILED: the check passed an image with a planted credential"
    printf '%s\n' "$output"
    return 1
  fi
  local rule
  for rule in "credential files in the image filesystem" \
    "an age private key" \
    "the value of \$SECRET_NEEDLE is present" \
    "credential-shaped variable"; do
    if ! printf '%s\n' "$output" | grep -qF -- "$rule"; then
      echo "SELF-TEST FAILED: the planted credential did not trip \"$rule\""
      printf '%s\n' "$output"
      return 1
    fi
  done
  echo "self-test passed: the filename, age-key, \$SECRET_NEEDLE and image-configuration rules all fired"
}

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image-ref> | --self-test" >&2
  exit 2
fi
case "$1" in
--self-test) self_test ;;
-*)
  echo "usage: $0 <image-ref> | --self-test" >&2
  exit 2
  ;;
*) check_image "$1" ;;
esac
