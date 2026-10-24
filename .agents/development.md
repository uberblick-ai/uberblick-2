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

Choose the narrowest layer that can expose the failure. Component tests own
most UI-state permutations; E2E tests keep the main user journeys and the
guarantees that need a real browser or the running system.

| Layer | Owns |
| --- | --- |
| Unit and lower-level integration | Parsing, transformations, sorting/filtering, eligibility, reason/message mappings and data invariants. Use real persistence or transport where the invariant depends on it. |
| Composed component | Screen and control states, permission/refusal variants, loading/empty/error/retry states, legacy-response compatibility and action wiring. Mount the relevant composition when routing or integration is the risk; a hook-only test cannot establish that the screen handles it correctly. |
| E2E | Representative discovery/creation/editing, comments/links, archive/restore/delete, decisions/history and workspace/account journeys. Keep native focus, keyboard/pointer/touch interaction, selection/copy, drag/resize, layout/geometry, clipping/scrolling, rendered fonts/SVG/canvas/contrast, real client convergence, acknowledgement boundaries, offline/restart and deployed auth/origin/CSP proofs here. |

Browser-observable outcomes still owe the `mise run e2e` proof in the command
table; this ownership does not change CI, review or merge gates. Existing E2E
coverage may supply that proof only when it asserts the changed outcome;
extend it where needed. A new UI state does not automatically need a new full
browser journey. Preserve the browser, input and appearance coverage required
by the live owning product guidance.

Keep theme checks on the states whose paint or geometry matters. Inspect both
appearances on the same fixture when possible, and perform appearance-independent
business transitions once per relevant input/browser path. Do not multiply
every error enum or business permutation across themes and devices. Keep
different failure models separate: relay and upstream acknowledgement,
interrupted join stages, and refusal before versus after restart are not
duplicates.

Before removing or combining an E2E case, record each distinct assertion's
surviving test in the PR or handoff. Browser and system guarantees in the E2E
row must stay in browser journeys with their relevant input, browser and
appearance coverage; only business/state permutations may move to lower-level
tests. Establish missing composed component coverage first, then run those
tests and the affected browser projects. Keep independent journeys diagnosable;
merging files or building a longer serial story just to reduce the count is
not an improvement. Asset
capture belongs outside routine acceptance unless the test checks a regression.

Use source-level line and branch coverage to find execution gaps, keeping
component and E2E results distinguishable. Equal executed lines do not prove
equal assertions or fault coverage. Compare per-file timings and CI wall time
separately from test counts. Keep coverage collection out of workload timing
measurements.
