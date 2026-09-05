# Releasing Uberblick through Homebrew

The release step is to create and push one exact `vMAJOR.MINOR.PATCH` tag at
the commit to publish. The source repository must already be public so the
formula can download its release payload without a GitHub account or token:

```sh
git tag v0.1.0
git push origin v0.1.0
```

That tag starts the repository's `Publish Homebrew release` workflow. Its only
job runs under the `homebrew-tap` environment, whose selected-tag policy is the
credential boundary for `HOMEBREW_TAP_TOKEN`. The job builds the versioned
install payload, checks the payload's own `ub --version`, publishes it on the
tag's GitHub Release, verifies that exact asset is anonymously downloadable,
and only then commits the generated public formula directly to
`uberblick-ai/homebrew-tap`. It refuses before creating a release while this
repository is private.

Before pushing a tag, the same build, version check, checksum, and formula can
be inspected without reading a credential or changing either repository:

```sh
mise run publish-homebrew-release -- v0.1.0 --dry-run
```

A published tag is immutable. Re-running a matching tag verifies and reuses
its published payload; it changes nothing when the tap formula matches and
refuses when the tag, payload, or formula disagree.
