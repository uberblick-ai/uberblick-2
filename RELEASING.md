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
