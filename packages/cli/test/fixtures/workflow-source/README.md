# Producer compatibility fixture

`uberblick-workflow-9.8.7.tar.gz` was built by the unmodified builder and shared
format module from `uberblick-ai/agent-workflows` commit
`b2ccfe08719d890c5e1c26d31ef8cf7aaf522812` (merged PR #4), using Node 26 and GNU
tar in an isolated Linux container. The consumer test needs neither that
checkout nor network access. It proves acceptance of the producer's actual
manifest/declaration/archive, then checks role reporting and the missing local
launch declaration case.

- Version: `9.8.7` (fixture only, never published).
- Synthetic source commit: `3b0d5db165a6024fe00ae0eb5d0283dd6a49abf2`.
- Payload SHA-256 (`uberblick-workflow-payload-v1`):
  `929140ec255f6798ac10a6cda23a4ba9845948f37d97fddbb13f65a9f8385ace`.
- Archive SHA-256:
  `1116eea142a55f4aefdbe6b20ee43deb37b13cafce7ad9b69b1723b62cedb82d`.

Refresh this fixture when an explicit workflow update changes its package format,
and rerun the consumer test. To refresh, use the reviewed source repository's `buildWorkflowPackage` export
on a disposable Git repository containing the three payload files in this
archive and this project-owned `.agents/launch.json` (one compact JSON line
followed by a newline):

```json
{"version":2,"project":{"repository":"fixture/workflow-source","baseRef":{"remote":"origin","branch":"main"}},"entryRoles":{}}
```

Commit with author/committer `Fixture <fixture@example.invalid>`, date
`2026-09-11T00:00:00Z` and message `workflow fixture`. Call
`buildWorkflowPackage({ root, version: "9.8.7", outputDir, env: {} })` under
Linux. Replace the archive and update provenance together. Tar timestamps can
change the archive checksum; the payload digest and synthetic source commit
remain reproducible. Do not copy the producer implementation into this project.
