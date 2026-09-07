# Installed agent MCP bootstrap and runtime trust (#927)

## Verdict

Do not ship the project launcher yet, but source-checkout absence is not the
blocker.

An installed `ub` payload registered a Codex project MCP entry and four fresh
Codex sessions called `sync_status`: on the ordinary host, inside a
source-visible mount namespace with `workspace-write`, in that namespace with
`danger-full-access`, and in the otherwise identical namespace with the three
Uberblick checkout paths masked. The source-visible/source-hidden pair both
passed. Its retained reductions do not establish literal one-variable identity:
the visible run recorded a user-config change that the hidden run did not, and
their prompt and output path carried different mode tokens. Neither difference
can turn a failure into a pass, so the paired successes still disprove source
absence as the established cause of the historical #909 failure.

The retained reduction attributes the runtime trust cost, although the
instrument that produced its per-operation windows is gone. Project-scoped
`ub mcp install` changed neither user configuration file. The first actual Codex
session for a control path wrote that path to `~/.codex/config.toml`, even with
an explicit command-line trust override. The first Claude session wrote a
project record to `~/.claude.json` with `hasTrustDialogAccepted: false`, even with
`--permission-mode auto`, and the timed-out Claude parent changed that file
again later in its session. Neither observed run needed an interactive trust
dialog, but both runtimes persisted project state. The `/opt/project` run order
was not retained, so the first-session rule for that path is inferred from the
three other control paths rather than independently demonstrated.

The Codex-parent → Claude-child direction completed, and the reduction reports
that the unretained modified fixture validated both independent results. Each
session's structured stream contains its own completed `sync_status` call. The
Claude-parent → Codex-child direction has a bounded limitation: both sessions
called `sync_status`, and the Codex child emitted the correct completed result,
but the Claude parent never received completion of the child runner or emitted a
final result before its ten-minute deadline.

There is one more production boundary. A fresh Codex control completed. After
an evidence-only edit to that control's child runner, the next two sessions used
the same parent argv, role and MCP entry. Their parent-authored final strings
reported that the project tool was unavailable or not callable; the retained
reduction contains no structured event, exit code, timestamp, control identity,
or `codex mcp list` output for those attempts. One string is a JavaScript
`TypeError` shape naming a Claude-style tool identifier, so the artifact cannot
separate a Codex discovery failure from an instrumented-runner failure. A second
control was reported to complete immediately. Fresh project bootstrap is
established elsewhere in the retained evidence, but repeatable standing-loop
bootstrap remains untested.

The secret-free event and configuration-change reductions, with exact
identities, are in
[927-installed-agent-runtime-evidence.json](./927-installed-agent-runtime-evidence.json).

## Demonstrated behaviour

### Installed payload and Codex discovery

These were the concrete paths used below (they are evidence identities, not
portable installation paths):

```sh
root=/tmp/claude-1000/-mnt-data-home-uberblick-uberblick/7e06004d-8624-4849-b3c2-47f25f366f25/scratchpad/mcp-codex-implementer-20260906T205153Z-36631537/spike927
payload="$root/installed/uberblick-0.0.1-spike927"
node_bin=/mnt/data/home/uberblick/.local/share/mise/installs/node/26/bin
```

The payload came from retained prototype `6402ee7695b0da20070dffd8aa1c4782aa614efe`:

```sh
mise run install
UBERBLICK_PAYLOAD_OUTPUT_DIR="$root/payload" \
  mise run build-install-payload -- 0.0.1-spike927
tar -xzf "$root/payload/uberblick-0.0.1-spike927.tar.gz" \
  -C "$root/installed"
```

The archive SHA-256 identity was
`bc79f5844db2423b272fe21b91b118da9f2fac2e8c922c0bfba3c0f3bfbfc47b`.
It is not a reproducible build digest: `tar -czf` recorded the fresh staging
tree's mtimes, uid and gid.
The unpacked tree digest was
`223cc690c55308555586c28dceb6e2eda3bb9d56118ea6f8faa0bc3d0cc334cf`
before and after the cross-runtime run. That digest is SHA-256 over sorted
relative path, mode and file content or symlink target, excluding timestamps.
The tree contained no `.agents`, `.claude`, `.codex` or `scripts` directory.
Only its `bin` directory was added ahead of the runtime and Node binaries on
`PATH`; no checkout-provided `ub` was present.

The payload was built from the retained prototype, so its bundled MCP server
predates the report's `grounding.main`. Code inspection during review found
`scripts/build-install-payload.mjs`, `packages/cli/src/install.ts` and
`packages/cli/src/mcp-config.ts` byte-identical between that prototype and the
report's current base; the `ub mcp install codex --project` behavior exercised
is therefore current, while the payload's MCP server is not evidence about the
current server implementation.

Each disposable project began without `.codex/config.toml`. From that project:

```sh
"$payload/bin/ub" mcp install codex --project \
  --workspace bd526fa1-4cb6-4590-bda6-ccb7262e30a2
```

The run reported that the installed command wrote only this project entry; the
project file itself was not retained in the evidence artifact:

```toml
[mcp_servers.uberblick]
command = "ub"
args = ["mcp", "serve"]

[mcp_servers.uberblick.env]
WORKSPACE_ID = "bd526fa1-4cb6-4590-bda6-ccb7262e30a2"
```

The ordinary-host invocation was:

```sh
PATH="$payload/bin:$node_bin:/usr/local/bin:/usr/bin:/bin" \
  /mnt/data/home/uberblick/.local/bin/codex exec \
  -C "$root/discovery-host" \
  -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -c "projects.\"$root/discovery-host\".trust_level=\"trusted\"" \
  --ephemeral --json -o "$root/ordinary.final.txt" \
  'Call the project-configured uberblick sync_status tool exactly once. Do not call any other tool and do not edit files. End with exactly: DISCOVERY ordinary workspace=<the workspace field returned by sync_status>'
```

The namespace controls mounted `/` read-only, rebound the runtime's own
`~/.codex` and Uberblick data directory read-write, bound the same project at
`/opt/project`, and bound the installed payload read-only at `/srv/installed`.
The source-hidden form alone overlaid empty filesystems on:

- `/mnt/data/home/uberblick/uberblick`;
- this run's detached implementation checkout; and
- the detached `6402ee7` prototype checkout.

All three `package.json` checks were positive in the visible namespace and
negative in the hidden namespace. The two source-visibility runs used the same
project bytes, project MCP configuration, `/opt/project` trust override,
`danger-full-access` sandbox, mount namespace and payload. Two retained
differences keep this from being a literal one-variable pair: the visible run
recorded the `/opt/project` trust entry in `~/.codex/config.toml` while the
hidden run did not, and the prompt plus `-o` path carried their visible/hidden
mode token. Neither difference can explain away a successful hidden run.

The namespace invoked the same inner command after those mounts; `SPIKE_SANDBOX`
was `danger-full-access` for the visible/hidden pair and `workspace-write` for
the separate sandbox check:

```sh
PATH="/srv/installed/bin:$node_bin:/usr/local/bin:/usr/bin:/bin" \
  /mnt/data/home/uberblick/.local/bin/codex exec \
  -C /opt/project -s "$SPIKE_SANDBOX" \
  -c sandbox_workspace_write.network_access=true \
  -c 'projects."/opt/project".trust_level="trusted"' \
  --ephemeral --json -o "/opt/project/$SPIKE_MODE.final.txt" \
  "Call the project-configured uberblick sync_status tool exactly once. Do not call any other tool and do not edit files. End with exactly: DISCOVERY namespace-$SPIKE_MODE workspace=<the workspace field returned by sync_status>"
```

| Condition | Namespace | Source | Sandbox | `sync_status` event | Final workspace |
| --- | --- | --- | --- | --- | --- |
| ordinary host | no | visible | `workspace-write` | completed | `bd526fa1-…` |
| namespace control | yes | visible | `workspace-write` | completed | `bd526fa1-…` |
| namespace control | yes | visible | `danger-full-access` | completed | `bd526fa1-…` |
| source-hidden pair | yes | masked | `danger-full-access` | completed | `bd526fa1-…` |

No discovery result differed, so `--ignore-user-config` and `CODEX_HOME` were
not varied to explain a difference. A separate `CODEX_HOME` would also mix
credential location into this question; this run did not copy, link or inspect
credentials.

### Trust and configuration writes

The normally authenticated starting state was `codex login status` → `Logged
in using ChatGPT` and Claude `auth status --json` → `loggedIn: true`,
`authMethod: "claude.ai"`, `apiProvider: "firstParty"`.

The run reported hashing the known user configuration paths immediately around
every registration and runtime boundary. The reduction retains the resulting
changed-path lists, but not the hashing instrument or configuration content.

| Operation | Required setup in this run | User configuration content changed |
| --- | --- | --- |
| `ub mcp install claude --project` | normal Claude authentication | none |
| `ub mcp install codex --project` | normal Codex authentication | none |
| Codex discovery, parent or child | `-c projects."<control>".trust_level="trusted"`; sandbox named explicitly | `~/.codex/config.toml`; the first-session rule is observed on three paths and inferred for `/opt/project`, whose run order was not retained |
| Claude parent or child | `--permission-mode auto`, project settings, named project agent; the parent also received `Bash(node scripts/run-codex-probe.mjs:*)` | `~/.claude.json` on the first session for that path and again later in the timed-out Claude parent session |

The reduction reports per-operation windows rather than one before/after
window; the missing instrument means that attribution cannot now be inspected.
For Project B it attributes `~/.codex/config.toml` to the parent-before-child
window, `~/.claude.json` to the child window, and nothing to the final window.
For Project A it attributes `~/.claude.json` before the child,
`~/.codex/config.toml` during the child, and another `~/.claude.json` change
before the parent deadline. The run reported safe readback of Codex
`trust_level = "trusted"` records and Claude project records with
`hasTrustDialogAccepted: false`; the actual path values were not retained, and
the JSON holds placeholder shapes.

This does not say that the trust records are undesirable. It says a production
launcher cannot promise “project files only” or “no user configuration writes.”

### Cross-runtime children

The run reported reusing the corrected #909 fixture's structured parent/child
validator, older candidate construction and control markers, with three
evidence-only changes outside the installed payload and candidates:

1. parent and child CLIs emitted `--json` or `--output-format stream-json
   --verbose` into separate files;
2. the two top-level directions ran sequentially so configuration writers could
   be attributed; and
3. each runtime was placed in its own process group with a ten-minute deadline.

Neither that modified fixture nor the instrumented child runner was retained,
and all four control and candidate commits plus their working trees are gone.
The fixture on `main` instead runs both directions concurrently, uses a
twenty-minute deadline and aborts on a nonzero parent exit. Consequently the
per-operation attribution and `fixtureValidation: "pass"` below rest on an
instrument that cannot now be inspected; the three modifications above are the
run's description, not independently verifiable artifact content.

The launched parent command remained the installed prototype surface:

```sh
control="$root/cross-evidence/project-a"
candidate="$root/cross-evidence/candidate-a"
"$payload/bin/ub" agents launch probe-parent \
  --project "$control" --candidate "$candidate" --model claude

control="$root/cross-b-evidence/project-b"
candidate="$root/cross-b-evidence/candidate-b"
"$payload/bin/ub" agents launch probe-parent \
  --project "$control" --candidate "$candidate" --model codex
```

The control tree stayed the parent's working directory. The older candidate was
only an additional directory. Project A's candidate predated the agent files;
Project B's candidate carried deliberately conflicting `*_CANDIDATE_WRONG`
adapters. Project B's retained result reports its candidate clean. Project A's
modified runner also reported its candidate clean, but that is not independently
established because its parent exited 143 before the retained fixture's
throw-guarded cleanliness check could have completed.

| Direction | Parent evidence | Child evidence | Independent validator |
| --- | --- | --- | --- |
| Claude → Codex | Claude structured `tool_use` for `mcp__uberblick__sync_status`; then one Bash child-runner event; no final result before deadline | Codex `item.completed` for `uberblick.sync_status`; final `CHILD marker=PROJECT_A_CONTROL … candidate=a-candidate-content` | not reached: the parent never delivered the child's completed output |
| Codex → Claude | Codex `item.completed` for `uberblick.sync_status`; final parent line embeds the exact child result | Claude structured `tool_use` for `mcp__uberblick__sync_status`; final `CHILD marker=PROJECT_B_CONTROL … candidate=b-candidate-content` | run-reported pass: parent and separately captured child marker, workspace and candidate all match; validator not retained |

Project A's Codex child ran from `21:10:52Z` to `21:11:27Z` and exited 0. The
Claude parent began at `21:10:37Z`; its stream recorded the child command as a
foreground Bash task, but never recorded a Bash result. The run reported that
the deadline sent `SIGTERM` at `21:20:37Z`; that send instant is not retained,
while the artifact does retain the parent's exit 143 at `21:20:38Z`. This is a
bounded negative result, not a claim that the child failed.

The successful fresh Project B run lasted from `21:29:55Z` to `21:30:42Z`.
The run reported its Claude child lasting from `21:30:22Z` to `21:30:37Z`, but
those child timestamps are not retained; both child and parent exit 0 are
retained. The unretained modified fixture reported `bounded-failure` only
because the two attributed user configuration files changed, not because its
validator failed.

## Disproved assumptions

- **Source-hidden means source-dependent Codex MCP:** disproved as a causal
  claim. The paired hidden run and visible control both passed; the retained
  trust-entry and mode-token differences cannot explain a pass away.
- **Project MCP registration writes runtime user config:** disproved for both
  clients. Their vendor registration commands wrote project files only.
- **An explicit non-interactive trust/permission flag means no persistent
  project record:** disproved. Both runtimes wrote their own user-level record.
- **The historical parent strings prove both child paths:** still disproved.
  Project B is now corroborated. Project A's child is corroborated, but its
  parent did not complete.

For the repeated-path observation, the first Codex parent completed
`sync_status` and its child, corroborated by the separate cross-runtime block.
After the child runner gained evidence instrumentation, the next two parent
invocations used the same recorded argv, role and MCP entry. Their retained
parent-authored final strings respectively say the tool was “not a function”
and “unavailable.” No structured event, stream absence, exit code, timestamp,
control identity or `codex mcp list` output was retained for either attempt, so
the claims that the tool was not exposed, that the streams contained no event,
and that the MCP entry remained enabled are parent-reported rather than
observed. The `is not a function` text is a JavaScript `TypeError` shape naming
a Claude-style tool identifier, so the reduction cannot distinguish a Codex
discovery failure from the newly instrumented runner throwing. The reported
intermittence establishes only a repeatability risk, not its layer or cause.

## Untested limitations

- No macOS, Windows, second workspace, long-running loop or parallel project
  matrix was run. The owner requested one bounded host investigation.
- `--ignore-user-config`, an alternate `CODEX_HOME` and a fresh
  `CLAUDE_CONFIG_DIR` were not rerun. No passing result needed them for
  explanation, and moving a runtime home would also move normal authentication.
- The source-hidden pair masked checkout contents but retained the authenticated
  runtime homes and the machine's Uberblick configuration. It tested checkout
  independence, not credential isolation.
- The stream reduction retains tool identity, status and final output, not tool
  result bodies, model reasoning, credentials or unrelated user configuration.
- The modified fixture, instrumented child runner, control and candidate
  repositories, and raw streams were not retained. The criterion-2 attribution
  and criterion-3 validator result therefore cannot be inspected from this
  artifact.
- Repeatable Codex discovery in one unchanged control was not isolated. The two
  parent-reported same-path failures followed an evidence-only child-runner
  commit, but their block retains no structured events or process results.
- `/opt/project` run order was not retained. The first-session trust-write rule
  for that path is inferred from the other three observed control paths.
- The prototype still carries `danger-full-access` in its project launch data.
  The direct namespace control shows `workspace-write` can initialize and call
  MCP on this host; this spike does not choose a production sandbox.
- Nothing here tests installation, updates, standing-loop recovery, production
  issue claims or a shipped `ub agents` command. No product data was written.

## Remaining boundary and owner question

Two runtime proofs remain before production launcher mechanics: repeatable
Codex project-MCP discovery in the same control, and a Claude parent receiving
and returning the completed Codex child result under retained structured
evidence. A future probe must create fresh minimal controls and retain its
instrument, repositories and structured process results; the exact historical
failures cannot be reproduced because their controls are gone. It should not add
a new bootstrap or permission mechanism until one failed layer is identified.

One product choice is now ready:

> May the supported project-launch contract accept each runtime's ordinary
> user-level per-project record, or must credentials and mutable project state
> be separated before `ub agents launch --project` can ship?

Options:

1. **Accept and document the runtime-owned records.** `ub` continues to install
   MCP in the project. A launch names its sandbox/permission mode and trust
   override, documents that Codex and Claude persist an absolute-path project
   record, and never claims user-config-neutral operation.
2. **Require separated credential and project state.** Keep production launch
   blocked until each runtime has a demonstrated configuration layout that
   reuses normal authentication without copying credentials and keeps mutable
   project state outside the ordinary user files.

Recommendation: option 1. The records are current runtime behavior, contain
project trust rather than Uberblick credentials, and zero user-configuration
writes was explicitly not a pass condition for this spike. Option 2 adds an
isolation contract neither runtime has demonstrated and should be chosen only
if that separation is itself a product requirement. This recommendation does
not waive the two runtime proof gaps above and does not reopen the project-local
installation journey or the `ub agents` command grouping.

## Process hygiene

Every real runtime had a separate process group, a ten-minute deadline and a
thirty-second escalation. The outer fixtures had their own deadlines. The one
timed-out Claude parent and its descendants were absent after cleanup; no
run-owned process retained a project or candidate working directory. The
installed-tree digest remained unchanged. Project B's candidate cleanliness is
retained; Project A's was runner-reported but is not independently established.
No credentials or runtime configuration contents were copied into the
repository.
