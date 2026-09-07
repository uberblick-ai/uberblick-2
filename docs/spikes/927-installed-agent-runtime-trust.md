# Installed agent MCP bootstrap and runtime trust (#927)

## Verdict

Do not ship the project launcher yet, but source-checkout absence is not the
blocker.

An installed `ub` payload registered a Codex project MCP entry and four fresh
Codex sessions called `sync_status`: on the ordinary host, inside a
source-visible mount namespace with `workspace-write`, in that namespace with
`danger-full-access`, and in the otherwise identical namespace with the three
Uberblick checkout paths masked. The source-visible/source-hidden pair both
passed. The historical source-hidden failure in #909 was therefore a compound
observation; this run disproves source absence as its established cause.

The runtime trust cost is now attributable. Project-scoped `ub mcp install`
changed neither user configuration file. The first actual Codex session for a
control path wrote that path to `~/.codex/config.toml`, even with an explicit
command-line trust override. The first Claude session wrote a project record to
`~/.claude.json` with `hasTrustDialogAccepted: false`, even with
`--permission-mode auto`. Neither observed run needed an interactive trust
dialog, but both runtimes persisted project state.

The Codex-parent → Claude-child direction completed and the corrected fixture
validated both independent results. Each session's structured stream contains
its own completed `sync_status` call. The Claude-parent → Codex-child direction
has a bounded limitation: both sessions called `sync_status`, and the
Codex child emitted the correct completed result, but the Claude parent never
received completion of the child runner or emitted a final result before its
ten-minute deadline.

There is one more production boundary. A fresh Codex control completed. After
an evidence-only edit to that control's child runner, the next two sessions used
the same parent argv, role and MCP entry but did not expose or call the project
tool even though `codex mcp list` still showed the entry enabled. A second
control carrying the instrumented runner completed immediately. The evidence
establishes fresh project bootstrap, but repeatable standing-loop bootstrap is
not yet established.

The secret-free event reductions, exact identities and configuration hashes are
in [927-installed-agent-runtime-evidence.json](./927-installed-agent-runtime-evidence.json).

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

The archive SHA-256 was
`bc79f5844db2423b272fe21b91b118da9f2fac2e8c922c0bfba3c0f3bfbfc47b`.
The unpacked tree digest was
`223cc690c55308555586c28dceb6e2eda3bb9d56118ea6f8faa0bc3d0cc334cf`
before and after the cross-runtime run. It contained no `.agents`, `.claude`,
`.codex` or `scripts` directory. Only its `bin` directory was added ahead of
the runtime and Node binaries on `PATH`; no checkout-provided `ub` was present.

Each disposable project began without `.codex/config.toml`. From that project:

```sh
"$payload/bin/ub" mcp install codex --project \
  --workspace bd526fa1-4cb6-4590-bda6-ccb7262e30a2
```

The installed command wrote only this project entry:

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
negative in the hidden namespace. The two source-visibility runs otherwise used
the same project bytes, project MCP configuration, `/opt/project` trust
override, `danger-full-access` sandbox, mount namespace, runtime home, payload
and prompt.

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

The known user configuration paths were hashed immediately around every
registration and runtime boundary. Content was never copied into evidence.

| Operation | Required setup in this run | User configuration content changed |
| --- | --- | --- |
| `ub mcp install claude --project` | normal Claude authentication | none |
| `ub mcp install codex --project` | normal Codex authentication | none |
| Codex discovery, parent or child | `-c projects."<control>".trust_level="trusted"`; sandbox named explicitly | `~/.codex/config.toml` on the first session for that absolute control path |
| Claude parent or child | `--permission-mode auto`, project settings, named project agent; the parent also received one explicit runner grant | `~/.claude.json` on the first session for that absolute control path |

The writes are attributable rather than inferred from one before/after window.
For the successful Project B run, the Codex parent changed only
`~/.codex/config.toml` before the child began; the Claude child changed only
`~/.claude.json`; nothing changed between child completion and parent
completion. Project A showed the inverse nesting: the Claude parent changed
only `~/.claude.json` before the child, the Codex child changed only
`~/.codex/config.toml`, and Claude changed its own file again before the parent
deadline. Safe readback showed Codex `trust_level = "trusted"` records for the
exact paths and Claude project records with `hasTrustDialogAccepted: false`.

This does not say that the trust records are undesirable. It says a production
launcher cannot promise “project files only” or “no user configuration writes.”

### Cross-runtime children

The run reused the corrected #909 fixture's structured parent/child validator,
older candidate construction and control markers. It made three evidence-only
changes outside the installed payload and candidates:

1. parent and child CLIs emitted `--json` or `--output-format stream-json
   --verbose` into separate files;
2. the two top-level directions ran sequentially so configuration writers could
   be attributed; and
3. each runtime was placed in its own process group with a ten-minute deadline.

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
adapters. Both candidate worktrees were clean after their runs.

| Direction | Parent evidence | Child evidence | Independent validator |
| --- | --- | --- | --- |
| Claude → Codex | Claude structured `tool_use` for `mcp__uberblick__sync_status`; then one Bash child-runner event; no final result before deadline | Codex `item.completed` for `uberblick.sync_status`; final `CHILD marker=PROJECT_A_CONTROL … candidate=a-candidate-content` | not reached: the parent never delivered the child's completed output |
| Codex → Claude | Codex `item.completed` for `uberblick.sync_status`; final parent line embeds the exact child result | Claude structured `tool_use` for `mcp__uberblick__sync_status`; final `CHILD marker=PROJECT_B_CONTROL … candidate=b-candidate-content` | passed: parent and separately captured child marker, workspace and candidate all match |

Project A's Codex child ran from `21:10:52Z` to `21:11:27Z` and exited 0. The
Claude parent began at `21:10:37Z`; its stream recorded the child command as a
foreground Bash task, but never recorded a Bash result. At `21:20:37Z` the
parent's own deadline sent `SIGTERM`; it exited 143 at `21:20:38Z`. This is a
bounded negative result, not a claim that the child failed.

The successful fresh Project B run lasted from `21:29:55Z` to `21:30:42Z`.
The Claude child ran from `21:30:22Z` to `21:30:37Z`; both exited 0. The fixture
reported `bounded-failure` only because the two attributed user configuration
files changed, not because validation failed.

## Disproved assumptions

- **Source-hidden means source-dependent Codex MCP:** disproved as a causal
  claim. The paired hidden run passed with the same namespace, config and
  sandbox as its visible control.
- **Project MCP registration writes runtime user config:** disproved for both
  clients. Their vendor registration commands wrote project files only.
- **An explicit non-interactive trust/permission flag means no persistent
  project record:** disproved. Both runtimes wrote their own user-level record.
- **The historical parent strings prove both child paths:** still disproved.
  Project B is now corroborated. Project A's child is corroborated, but its
  parent did not complete.

For the repeated-path observation, the first Codex parent completed
`sync_status` and its child. After the child runner gained evidence
instrumentation, the next two parent invocations used the same recorded argv,
role and MCP entry; their final lines respectively said the tool was “not a
function” and “unavailable,” and neither stream contained an MCP tool event.
`codex mcp list` from that control still reported `uberblick` enabled. The
instrumented runner is downstream of the failed parent call, and a newly
created control with that same instrumentation passed, but the intervening
control commit means this is an unisolated intermittence rather than a
disproved repeatability claim. It is not enough evidence to name whether config
discovery, MCP startup or runtime tool selection failed.

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
- Repeatable Codex discovery in one unchanged control was not isolated. The two
  failed same-path observations followed an evidence-only child-runner commit,
  so they establish a risk to reproduce, not its cause.
- The prototype still carries `danger-full-access` in its project launch data.
  The direct namespace control shows `workspace-write` can initialize and call
  MCP on this host; this spike does not choose a production sandbox.
- Nothing here tests installation, updates, standing-loop recovery, production
  issue claims or a shipped `ub agents` command. No product data was written.

## Remaining boundary and owner question

Two runtime proofs remain before production launcher mechanics: repeatable
Codex project-MCP discovery in the same control, and a Claude parent receiving
and returning the completed Codex child result under retained structured
evidence. The smallest next probe should reproduce those exact failures; it
should not add a new bootstrap or permission mechanism until one failed layer is
identified.

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
candidate worktrees and installed tree remained unchanged. No credentials or
runtime configuration contents were copied into the repository.
