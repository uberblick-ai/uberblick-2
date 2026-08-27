#!/usr/bin/env bash
# Build the Dockerfile's `hub` target for one commit and publish it.
#
#   scripts/publish-hub-image.sh <full-commit-sha>
#
# Two tags per commit, and they mean different things. `sha-<full-commit-sha>`
# is an immutable name for one build and is never overwritten: when it already
# exists this script prints its digest and pushes nothing. `main` is a moving
# discovery pointer — what a human reads to find the newest image — and never a
# runtime reference: a deployment pins the digest printed here. That is the
# split `remote-update.sh` already runs on, where the moving `origin/main` is
# consulted and the immutable commit it resolved to is what gets recorded.
#
# The hub target mounts no build secret (the only `--mount=type=secret` in the
# Dockerfile belongs to the web bundle, a different target), so nothing here
# needs the age key. Because the published image is public, the push is followed
# by `scripts/check-image-secrets.sh` over the pulled artefact: a failure there
# fails the job, so a disclosure is loud rather than quiet.
#
# IMAGE and MOVING_TAG override the defaults, which is how this is rehearsed
# against a throwaway local registry.
set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/uberblick-ai/uberblick-hub}"
MOVING_TAG="${MOVING_TAG:-main}"

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly REPO_ROOT

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <full-commit-sha>" >&2
  exit 2
fi
commit=$1
if ! printf '%s' "$commit" | grep -qE '^[0-9a-f]{40}$'; then
  echo "expected a full 40-character commit sha, got: $commit" >&2
  exit 2
fi
tag="sha-$commit"

digest_of() {
  docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}'
}

report() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
}

# An immutable tag is never rebuilt over. An inspect that fails for any reason
# other than "no such tag" is a refusal, not a licence to push: guessing wrong
# in that direction is what would overwrite a published digest.
if inspect=$(docker buildx imagetools inspect "$IMAGE:$tag" 2>&1); then
  report "$IMAGE:$tag is already published as $(digest_of "$IMAGE:$tag") — nothing pushed."
  exit 0
elif ! printf '%s' "$inspect" |
  grep -qiE 'not found|manifest unknown|name unknown|denied|unauthorized|404'; then
  printf '%s\n' "$inspect" >&2
  echo "could not determine whether $IMAGE:$tag exists; refusing to push" >&2
  exit 1
fi

echo "$IMAGE:$tag is not published yet; building it."

# The default "docker" builder can only push straight to a registry when the
# daemon happens to use the containerd image store; a docker-container builder
# can on any daemon. Pinning one here is what keeps the published artefact from
# depending on how the machine that ran the build was configured. Setting
# BUILDX_BUILDER — buildx's own variable — opts out, which is how this is
# rehearsed against a local registry.
if [ -z "${BUILDX_BUILDER:-}" ]; then
  docker buildx inspect uberblick-publish >/dev/null 2>&1 ||
    docker buildx create --name uberblick-publish --driver docker-container >/dev/null
  export BUILDX_BUILDER=uberblick-publish
fi
# --provenance=false keeps this a plain image manifest rather than an index with
# an attestation hanging off it. Provenance and SBOM attestations are a decision
# nobody has taken yet, and an unasked-for one would change what an anonymous
# `docker pull` of this tag resolves to.
docker buildx build \
  --target hub \
  --provenance=false \
  --tag "$IMAGE:$tag" \
  --tag "$IMAGE:$MOVING_TAG" \
  --push \
  "$REPO_ROOT"

digest=$(digest_of "$IMAGE:$tag")
report "pushed $IMAGE@$digest"
report "  immutable: $IMAGE:$tag"
report "  moving:    $IMAGE:$MOVING_TAG"

moving_digest=$(digest_of "$IMAGE:$MOVING_TAG")
if [ "$moving_digest" != "$digest" ]; then
  echo "$IMAGE:$MOVING_TAG resolves to $moving_digest, not the digest just pushed" >&2
  exit 1
fi

# Over the pulled artefact, not the local build: what is published is what has
# to be clean.
docker pull --quiet "$IMAGE@$digest" >/dev/null
"$REPO_ROOT/scripts/check-image-secrets.sh" "$IMAGE@$digest"
