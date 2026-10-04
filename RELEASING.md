# Releasing Uberblick

Client releases and hub releases are independent. Client tags are `vX.Y.Z`;
hub tags are `hub-vX.Y.Z`. Neither tag family starts the other publisher.
A person pushes a tag deliberately; merges and schedules publish nothing.

## Client releases through Homebrew

The release step is to create and push one exact `vMAJOR.MINOR.PATCH` tag at
the commit to publish. This repository stays private; the release artifact is
published on the public tap repository `uberblick-ai/homebrew-tap`, so the
formula downloads it without a GitHub account or token:

```sh
git tag v0.1.0
git push origin v0.1.0
```

That tag starts the repository's `Publish Homebrew release` workflow. Its only
job runs under the `homebrew-tap` environment, whose selected-tag policy is the
credential boundary for `HOMEBREW_TAP_TOKEN` — the only credential the
publisher uses, because both the asset and the formula land on the tap. The job
builds the versioned install payload, checks the payload's own `ub --version`,
publishes it as an asset on a release of the same tag in the tap repository,
verifies that exact asset is anonymously downloadable, and only then commits the
generated public formula naming it. It refuses before creating a release while
the tap repository is not public.

One-time prerequisite before the first tag: the tap repository must hold at
least one commit on its default branch, because a GitHub release needs a commit
to target. The publisher refuses up front and names this step while the tap is
empty. Only that seed commit is made by hand; every formula is written by the
release workflow.

Before pushing a tag, the same build, version check, checksum, and formula can
be inspected without reading a credential or changing either repository:

```sh
mise run publish-homebrew-release -- v0.1.0 --dry-run
```

A published tag is immutable. Each release records the source commit it was
published from, so re-running a tag that has since been moved is refused before
anything changes. Re-running a matching tag verifies and reuses its published
payload; it changes nothing when the tap formula matches and refuses when the
tag, payload, or formula disagree.

If GitHub leaves the expected asset incompletely uploaded, delete that
incomplete asset before re-running the workflow. The publisher reports this
recovery and never deletes a release asset automatically.

## Hub releases through Docker

A hub release publishes two images for `linux/amd64`:
`ghcr.io/uberblick-ai/hub:X.Y.Z` and `ghcr.io/uberblick-ai/hub-web:X.Y.Z`.
Both are public, so an operator needs no GitHub account or registry login.
The hub image contains its bundled runtime and `/release`: the exact-version
Compose file, `.env` template, shared operator scripts, manuals and
`release.json`. The web image contains Caddy and one web bundle built without
any deployment endpoint, workspace or secret. Images contain service payloads,
not a source checkout. The release build scans the images and refuses `.env`,
`fnox.toml`, `mise.local.toml` or database files before publishing either one.

### One-time registry setup

The first release is an attended operation. An organization administrator checks
that `uberblick-ai` allows public container packages. The workflow publishes
with its own `GITHUB_TOKEN` (`packages: write`); it needs no separate registry
credential. If either package already exists, connect it to this repository and
ensure the repository's Actions workflows have package access.

GHCR initially creates packages private. After the first workflow push, open
each package's **Package settings → Change visibility** and make `hub` and
`hub-web` public. Package visibility is independent of this private repository;
check package access inheritance where necessary. The workflow does not change
organization or package visibility. See GitHub's
[container registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
and [package visibility instructions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Before offering the release to operators, verify both images from a clean
Docker credential configuration, without a login:

```sh
mkdir -p anonymous-docker-config
DOCKER_CONFIG="$PWD/anonymous-docker-config" docker pull --platform linux/amd64 ghcr.io/uberblick-ai/hub:0.1.0
DOCKER_CONFIG="$PWD/anonymous-docker-config" docker pull --platform linux/amd64 ghcr.io/uberblick-ai/hub-web:0.1.0
```

Use the version just published, then follow [REMOTE.md](REMOTE.md) on a Linux
host or Docker Desktop on macOS with no checkout. Apple Silicon runs the
`linux/amd64` images under emulation. Verify the no-Tailscale loopback launch,
GitHub claim, installed-client login and authenticated MCP and `ub open` sync,
then the selected HTTPS route and operator commands. Verify Tailscale daemon
certificate retrieval on Linux and public DNS certificate issuance on a host
with the required DNS and TCP 443 reachability. These are attended checks;
an image push alone does not prove anonymous deployment works.

### Cut a hub release

Choose the source commit and an unused independent hub version. From a clean
checkout of that commit, before pushing its tag, build both images and their host files with no registry credential and
no push:

```sh
mise run publish-hub-release -- hub-v0.1.0 --dry-run
```

Inspect the image references and `/release/release.json` as shown in REMOTE.md,
and run the Docker-only launch and update procedure with the local images. Confirm the
default Compose model publishes only `127.0.0.1:8080`, has no hub port, mounts
no Tailscale socket and builds nothing on the host. Verify the optional HTTPS
model replaces that publication with port 443, and the Tailscale model adds
only the daemon socket and its certificate access. Keep real certificate
issuance and the fresh Mac deployment explicit when the test machine cannot
provide them.

For a repeatable local proof after building two versions, run:

```sh
mise exec -- node scripts/hub-release-proof.mjs 0.1.0 0.2.0 "$(git rev-parse HEAD)"
```

This probe requires Docker Engine 28.0.0 and Compose 2.24.4 or newer, the release
floors. It extracts host files into empty directories and starts an isolated,
disposable project on loopback HTTP, then checks backup, restore, setup
status and replacement retaining private access and Caddy state. It cleans up
its containers and volumes. It does not exercise Tailscale or public DNS
certificate issuance, GitHub approval, the Mac Mini journey or anonymous
registry pulls; those remain attended release checks.

A person then tags the intended commit and pushes that tag:

```sh
git tag hub-v0.1.0 <source-commit>
git push origin hub-v0.1.0
```

Only this tag starts `Publish hub release`; it never starts `Publish Homebrew
release`. The workflow builds and checks both images, then pushes them to GHCR.
There is no `latest` tag or moving channel. A published version is immutable:
a rerun verifies the recorded source commit and reuses matching published
images without replacing them. A tag moved to another commit is refused before
anything is published. Fix a released version by cutting a new version,
never by moving or deleting its tag. If only one of the two images was
published, the rerun refuses the incomplete pair rather than rebuilding or
overwriting it. Cut a new version; never mix images from separate attempts.

### Protocol compatibility

Each release's `/release/release.json` records its `version`, `sourceCommit`,
`syncProtocolVersion` and image references. Both images carry release identity
labels as well. Operators can read this metadata with Docker alone as shown in
[REMOTE.md](REMOTE.md), even without repository access.

`SYNC_PROTOCOL_VERSION` in `packages/hub/src/protocol.ts` is the compatibility
unit. Release numbers may differ between the hub and Homebrew client. A hub
release changing anything covered by REMOTE.md's wire-semantics rule — token
shape or claims, protocol, room key or the served configuration contract — is
published together with a matching client release. Decide that pairing when
cutting the releases; operators move the host and every client in the same
sitting and reload browser tabs. Do not release one half as an upgrade operators
can safely apply alone.
