# Local development

The commands that build, run and validate a change:

| Command | Use |
| --- | --- |
| `mise trust` | prepare a new worktree to run the project's tasks |
| `mise run install` | install dependencies |
| `git pull`, then `mise run setup` | update a source checkout's code, toolchain and dependencies; `ub auth login` joins the committed workspace |
| `ub update` | update the Homebrew installation; a checkout binary refuses and names `git pull`, then `mise run setup` |
| `mise run build-web` | build the default bundle for checkout `ub open`, which refuses a missing or stale bundle without building it |
| `mise run dev` | local development services |
| `mise run lint`, `mise run typecheck`, `mise run test` | the final checks on an implementation |
| `mise run test-os` | the macOS CI job: only the suites whose behaviour can differ by OS |
| `mise run e2e` | the browser proof, owed when the outcome is browser-observable |
| `mise run ci` | everything GitHub CI runs, in its order, with a summary of what failed; `--skip-e2e` stops before the browser suite |
| `mise run review <sha>` | the isolated review in a container, for the merged-tree gate and failure-path probes |
| `mise exec -- pnpm run test:agent-cleanup`, `mise exec -- pnpm run test:housekeeping` | focused run-scratch cleanup and Docker housekeeping contract tests |
| `python3 scripts/cleanup-agent-worktree.py` | ub-agents hook before private-worktree removal; uses `UB_AGENTS_RUN` and `UB_AGENTS_WORKTREE` |
| `sh bin/housekeeping.sh <review sha>...` | the host cleanup an integrator runs after a durable outcome |

Prefer these to direct package-manager invocations. Development tasks resolve
the project's binding and private credentials themselves; `ub mcp serve` does
so for the MCP server. Do not dump resolved environment or credentials.
Keep secrets in the supported
credential store; never commit plaintext tokens or create secret .env files.
Where a corpus document governs the behavior you are changing, read it first.

Run focused checks while editing, then the required checks on the final change.
Always pass the intended SHA to `mise run review`; omitting it reviews the
runner checkout's HEAD. A failing test is not automatically environmental:
compare the relevant base before attributing the failure. Record real
limitations, not assumed passes.

## Test ownership

Make CI reliable and faster by testing each useful guarantee at the lightest
layer that can expose its failure. Avoid redundant coverage, unnecessary
infrastructure and long-running tests while preserving meaningful regression
protection. Coherent happy paths remain valuable.

### Choose the guarantee, then the method

When adding, changing or reassessing a test, name the failure it should detect.
Check that its inputs, doubles and assertions expose that failure; executing
the relevant code or obtaining a passing result is insufficient. Extend
existing adequate coverage where the case stays coherent. Add another layer
only when it exposes a distinct failure mechanism.

| Layer | Owns |
| --- | --- |
| Unit and lower-level integration | Rules, parsing, transformations, sorting/filtering and data invariants. Use real persistence or transport when the invariant depends on it. |
| Composed component | Screen and control states, permissions/refusals, validation, loading/empty/error/retry states, compatibility and action wiring. Mount the relevant production composition with controlled dependencies; a hook-only test cannot establish screen behavior. |
| Focused browser | Native keyboard/pointer/touch input, focus, composition where the runner drives native input, selection/copy, drag/resize, layout, clipping/scrolling, fonts and rendered SVG/canvas/contrast. Use production components, styles and the surrounding context needed to expose the failure. |
| System E2E | Representative discovery/creation/editing, comments/links, archive/restore/delete, decisions/history and workspace/account journeys; boundaries requiring the running system, including real client convergence, acknowledgement, persistence, offline/restart and deployed auth/origin/CSP behavior. |

Do not mock the boundary being proved. In-memory peers do not establish
transport, synthetic events do not establish native browser input, and supplied
search results do not establish search correctness. Concurrency claims need
control of the relevant interleaving; starting operations together does not
establish their ordering.

Browser-observable outcomes still owe the `mise run e2e` proof in the command
table. A focused browser fixture supplies browser proof through the existing
Playwright projects under `mise run e2e`, but cannot prove system boundaries it
omits. Preserve the desktop Chromium, iPad WebKit, input
and appearance coverage required by live product guidance. Existing coverage
supplies proof only when it asserts the changed outcome. These rules do not
change runtime configuration, timeouts, required CI jobs or merge gates.

### Use the smallest adequate setup

Prepare valid scenario state through reusable fixture builders or APIs. Use
the UI for preparation only when those actions belong to the guarantee.

Reuse existing fixture mechanisms and immutable bundles. Share services where
mutable state remains isolated. Each test owns its contexts, state and cleanup
and must run independently; do not create chains of tests. Tests that restart
or otherwise mutate shared services need their own instance.

Focused browser fixtures must retain the production composition needed for the
failure, including relevant providers, editor configuration, styles and focus
owners. Do not rebuild application behavior inside fixtures.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md#browser-tests) for readiness helpers,
arrival barriers, runner commands and quarantine handling. Wait for named
conditions and install observers before acting. Negative propagation
assertions need a positive barrier proving that a later update reached the
relevant reader. Poll assertions where appropriate; do not compensate for
unexplained failures with sleeps, whole-test retries or repeated user actions.

Wait for relevant fonts, rendering and transitions before measuring settled
paint or geometry. Tests of motion observe the transition itself. Use
controlled clocks for elapsed-time rules where real time is not the guarantee.

### Avoid overtesting

Keep business-state permutations in lower-level or component tests. Exercise
appearance-independent transitions once per relevant input/browser path;
inspect affected paint and geometry in both appearances without replaying the
whole journey. Do not multiply every error enum across themes and devices.
Test our configuration and composition of dependencies rather than
exhaustively retesting their internals or defaults. Merging files or building a
longer serial story merely to reduce the count is not an improvement.

Before removing or moving coverage, record each distinct guarantee's surviving
test by path and name in the PR or handoff. Establish missing replacement
coverage first. Native browser guarantees stay in focused-browser or system
E2E tests; running-system journey guarantees stay in system E2E, with the
required input/browser/appearance coverage.
Different acknowledgement paths, interrupted join stages and failures before
versus after restart are not duplicates.

A passing isolated replacement does not explain an application failure.
While a failure in supported application behavior remains unexplained, keep
application coverage (quarantined under CONTRIBUTING when necessary) and track
the failure. Retiring that coverage needs maintainer authorization; apply an
already-recorded answer that covers the case. Retiring a test is not repairing
an unexplained defect.

### Bound duration and verify the improvement

The normal review budget is **60 seconds per test, including its own setup and
cleanup**. Most tests should finish well below it. This is a review budget,
not a claim that current runner timeouts enforce it. Assess total duration;
hooks and teardown may have separate timeouts. Measure shared setup separately
and include it in CI wall time.
Do not move scenario work into shared hooks to evade the budget.

Investigate layer, setup and waits before increasing a budget. Splitting tests
helps only when it improves diagnosis or ownership without unnecessarily
repeating setup. Do not weaken assertions or shrink a required workload merely
to meet the limit. Necessary longer-running verification needs a clear purpose
and a human-approved budget; existing longer allowances need explicit
assessment, not automatic removal of their coverage.

If a test needed to verify new functionality repeatedly exceeds the 60-second
review budget or repeatedly times out, escalate it to a human maintainer before
increasing the budget, skipping or weakening the test, or accepting the
functionality as verified.

Validate replacements in the affected layers. For flaky-test repairs, include
repeated execution without retries at normal CI concurrency; a passing rerun
alone does not establish the cause or repair. Compare recurring failures,
per-test setup/execution/cleanup costs and CI wall time separately from counts.
Use line and branch coverage to find execution gaps while keeping component
and browser results distinguishable; equal executed lines do not establish
equal fault coverage. Keep coverage instrumentation out of workload timing
measurements and asset capture outside routine acceptance unless it checks a
regression.

### Responsibilities

- **Authors** choose the smallest adequate layer and method, explain heavier
  setups when the need is not evident, and identify surviving coverage when
  removing tests.
- **Reviewers** challenge redundancy, unnecessary infrastructure,
  implementation trivia and unsupported claims, and verify that required
  guarantees survive.
- **Human maintainers** decide necessary time-budget exceptions and proposals
  to relinquish required coverage.
