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
# needs the age key. Because the published image is public, the build is loaded
# locally and `scripts/check-image-secrets.sh` runs over it *before* anything is
# pushed: a leak that reached the registry first would be public under two tags
# before it was reported, and the never-overwrite rule would then leave that
# commit unrepairable.
#
# A first publish creates the GHCR package with the repository's visibility,
# i.e. private, and `packages: write` cannot change that. Someone with admin
# rights flips it to Public once, in the package settings; nothing here can.
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

# Digests and image references are not prose: the job summary gets them inside
# one fenced block, opened here and closed on every exit path.
close_summary() {
  printf '```\n' >>"$GITHUB_STEP_SUMMARY"
}
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '```\n' >>"$GITHUB_STEP_SUMMARY"
  trap close_summary EXIT
fi

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
# Loaded into the local image store rather than pushed: nothing reaches the
# registry until the scan below has passed. --provenance=false is what makes
# --load work on a daemon whose image store cannot hold attestations, and it
# keeps the published artefact a plain image manifest rather than an index with
# an attestation hanging off it — provenance and SBOM attestations are a
# decision nobody has taken yet.
docker buildx build \
  --target hub \
  --provenance=false \
  --tag "$IMAGE:$tag" \
  --load \
  "$REPO_ROOT"

"$REPO_ROOT/scripts/check-image-secrets.sh" "$IMAGE:$tag"

# The scanned bytes are the published bytes: this pushes the image that was just
# checked instead of building a second one. The immutable tag goes first, so a
# failure between the two leaves the commit published under the name that pins
# it, with the moving pointer merely not caught up yet.
docker push --quiet "$IMAGE:$tag"
docker tag "$IMAGE:$tag" "$IMAGE:$MOVING_TAG"
docker push --quiet "$IMAGE:$MOVING_TAG"

digest=$(digest_of "$IMAGE:$tag")
report "pushed $IMAGE@$digest"
report "  immutable: $IMAGE:$tag"
report "  moving:    $IMAGE:$MOVING_TAG"

moving_digest=$(digest_of "$IMAGE:$MOVING_TAG")
if [ "$moving_digest" != "$digest" ]; then
  echo "$IMAGE:$MOVING_TAG resolves to $moving_digest, not the digest just pushed" >&2
  exit 1
fi

# What the registry serves must be the local image the scan passed, not merely
# an image with the same tag.
repo_digests=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE:$tag")
pushed_digest=$(printf '%s\n' "$repo_digests" | sed -n "s|^$IMAGE@||p" | sed -n '1p')
if [ "$pushed_digest" != "$digest" ]; then
  echo "$IMAGE:$tag serves $digest, but the scanned image pushed as $pushed_digest" >&2
  exit 1
fi
report "  scanned before push, and the registry serves that same digest"
