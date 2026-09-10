# Releasing Uberblick through Homebrew

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

## Releasing the agent workflow package

The delivery workflow in `.agents/` is published as its own artifact, on its own
tag namespace, so a project elsewhere can adopt one named version of it. A
workflow version is the asset `uberblick-workflow-<version>.tar.gz` on tag
`workflow-v<MAJOR>.<MINOR>.<PATCH>` of the same public tap repository. That is
the only address a version resolves to, and it can never collide with the
product's own `v<MAJOR>.<MINOR>.<PATCH>` releases or with
`uberblick-<version>.tar.gz`: each publisher refuses the other's spelling.

Build one locally to inspect what it would publish — no credential, no network,
nothing changed:

```sh
mise run build-workflow-package -- 0.1.0  # dist/uberblick-workflow-0.1.0.tar.gz
```

The package holds a `manifest.json` beside a `payload/` tree. The payload is
exactly what `.agents/requires.json` declares portable, taken from the current
`HEAD`; the manifest names the workflow, the version, the source commit, the
digest algorithm and framing, and one entry per payload file with the mode git
records for it. The build refuses a checkout that has drifted from that commit,
a declared path that is not an ordinary repository-relative file, a declared
file that is missing, and a payload entry carrying one of this project's own
declared bindings — the source repository is private and this artifact is
public. It also refuses to run with `HOMEBREW_TAP_TOKEN` in its environment: the
credential belongs at the upload boundary, not in the step that assembles a
payload.

Publishing runs from the same `Publish Homebrew release` workflow and the same
single `homebrew-tap` environment, dispatching on the pushed tag, so neither the
credential boundary nor the number of places that name it changes. **Pushing a
`workflow-v…` tag does not publish anything yet:** that environment's
selected-tag policy admits only `v[0-9]*.[0-9]*.[0-9]*`, so the job is refused
the credential. Changing that policy, seeding the tap and performing the first
publication are one separately authorized operation, tracked as #967.
