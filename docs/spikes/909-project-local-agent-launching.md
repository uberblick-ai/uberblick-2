# Project-local agent launching and candidate isolation (#909)

## Verdict

Keep the project/control split, but do not ship the tested command yet.

An installed `ub` payload can select a project's workflow, start a real Claude
or Codex parent there, and let that parent start the other runtime while both
inspect an older candidate tree. A four-session run selected projects A and B
concurrently from a directory outside both. Every session reported its
project's control marker and MCP workspace pin; project B's stale candidate
marker never appeared, neither candidate changed, and the installed payload's
tree digest remained unchanged.

The experiment also found two blockers rather than proving the full contract:

- Both current runtime CLIs wrote project trust state into their user-level
  configuration. Claude Code 2.1.263 added project records to
  `~/.claude.json`; Codex CLI 0.152.1 added trusted-project records to
  `~/.codex/config.toml`. The fixture detected both writes and ended with
  `verdict: "bounded-failure"`.
- In a stricter Linux mount-namespace control where both source-checkout paths
  were unreadable, the installed payload still launched the real parents, but
  neither Codex invocation exposed the project's configured `sync_status` MCP
  tool. The Codex parent stopped before its child; the Codex child under the
  Claude parent reported the same missing tool. This disproves the stronger
  claim that the tested transport works with the source tree absent.

The smallest next implementation therefore needs explicit runtime trust and
configuration contracts plus a Codex project-MCP bootstrap that survives a
source-hidden installed environment. The control/candidate transport shape is
promising; checkout-free, user-config-neutral unattended launch is not yet
proved.

## Reproduction artifacts

The disposable CLI prototype is retained, unmerged, at
[`6402ee7695b0da20070dffd8aa1c4782aa614efe`](https://github.com/uberblick-ai/uberblick-2/commit/6402ee7695b0da20070dffd8aa1c4782aa614efe)
on `spike/909-project-local-launch-prototype`. It adds only the probe form of
`ub agents launch`; no production branch carries it. This PR carries the
fixture at `docs/spikes/909-project-local-launch-fixture.mjs`.

From a checkout of this PR, the following recreates the payload and the two
projects. Use a real workspace UUID known to the local `ub`; the fixture calls
only `sync_status` and never mutates product data.

```sh
report_root=$(git rev-parse --show-toplevel)
spike_root=$(mktemp -d)
git worktree add --detach "$spike_root/prototype" \
  6402ee7695b0da20070dffd8aa1c4782aa614efe
cd "$spike_root/prototype"
mise run install
UBERBLICK_PAYLOAD_OUTPUT_DIR="$spike_root/payload" \
  mise run build-install-payload -- 0.0.1-spike909
mkdir "$spike_root/installed"
tar -xzf "$spike_root/payload/uberblick-0.0.1-spike909.tar.gz" \
  -C "$spike_root/installed"
cd "$spike_root"
node "$report_root/docs/spikes/909-project-local-launch-fixture.mjs" \
  --ub "$spike_root/installed/uberblick-0.0.1-spike909/bin/ub" \
  --root "$spike_root/evidence" \
  --workspace <workspace-uuid>
```

The expected result on the recorded runtime versions is JSON with
`verdict: "bounded-failure"`, four successful marker/workspace readings,
clean candidates, an unchanged installed tree, and both user config paths
under `changedUserRuntimeConfig`. It exits non-zero because a configuration
write that was required not to happen is evidence, not success. Each runtime
process has a 20-minute deadline and its own process group; the fixture waits
for both groups and escalates only those exact groups if needed.

The stricter Linux source-hidden control copied only the fixture into the
namespace, masked both checkout parents, and mounted the unpacked payload
read-only. It used the existing authenticated runtime homes because copying
credentials was deliberately out of scope. Consequently this command can add
the trust entries the fixture reports; run it only with that side effect
understood.

```sh
workspace_id=<workspace-uuid>
hidden_root="$spike_root/source-hidden"
mkdir -p "$hidden_root/evidence"
cp "$report_root/docs/spikes/909-project-local-launch-fixture.mjs" \
  "$hidden_root/fixture.mjs"

bwrap --die-with-parent --ro-bind / / --dev /dev --proc /proc \
  --tmpfs /tmp --chmod 1777 /tmp \
  --tmpfs /mnt/data/home/uberblick/uberblick \
  --bind "$HOME/.claude" "$HOME/.claude" \
  --bind "$HOME/.claude.json" "$HOME/.claude.json" \
  --bind "$HOME/.codex" "$HOME/.codex" \
  --bind "$hidden_root" /opt \
  --ro-bind "$spike_root/installed" /srv \
  --chdir /opt \
  sh -ceu '
    test ! -e "$1"
    test ! -e "$2"
    exec node /opt/fixture.mjs \
      --ub /srv/uberblick-0.0.1-spike909/bin/ub \
      --root /opt/evidence \
      --workspace "$3"
  ' sh "$report_root" "$spike_root/prototype" "$workspace_id"
```

The two `test` commands passed. The fixture then stopped on the absent Codex
MCP tool as recorded below; that non-zero result is the source-hidden
observation, not a recipe expected to pass.

The final recorded functional run on 2026-09-06 used:

- Codex CLI 0.152.1 and Claude Code 2.1.263.
- Prototype head `6402ee7`; payload version `0.0.1-spike909`.
- Project A: Claude parent → supervised Codex child; control `f6d842f`,
  candidate `e793a05`, whose candidate commit had no agent files.
- Project B: Codex parent → foreground Claude child; control `f596dbc`,
  candidate `10f6e7c`, whose older Claude/Codex reviewer adapters carried the
  conflicting marker `PROJECT_B_CONTROL_CANDIDATE_WRONG`.
- Installed payload digest
  `db5ea8e279c344e238286a75eff4b2846cd8fe4341148e7954b7855bb389fbe8`
  before and after the sessions. Its archive contained no `.agents`, `.claude`,
  `.codex`, or `scripts` directory.

The two final parent readings were:

```text
PARENT marker=PROJECT_A_CONTROL workspace=bd526fa1-4cb6-4590-bda6-ccb7262e30a2 child="CHILD marker=PROJECT_A_CONTROL workspace=bd526fa1-4cb6-4590-bda6-ccb7262e30a2 candidate=a-candidate-content"
PARENT marker=PROJECT_B_CONTROL workspace=bd526fa1-4cb6-4590-bda6-ccb7262e30a2 child="CHILD marker=PROJECT_B_CONTROL workspace=bd526fa1-4cb6-4590-bda6-ccb7262e30a2 candidate=b-candidate-content"
```

## Demonstrated behaviour

### Installed artifact and explicit project selection

The prototype resolved `.agents/launch.json`, the role contract, and both
runtime adapters from the explicit `--project` directory. It never derived an
Uberblick checkout root from its own module path. Both top-level commands were
spawned concurrently with the fixture root as their working directory,
outside projects A and B; each runtime child then ran with its selected project
as the control working directory.

The payload was built and unpacked outside the report checkout. The session
environment put only that payload's `bin` first on `PATH`. The fixture compares
every installed path, mode, symlink target, and file byte before and after the
run. Equality reached the later configuration check, establishing that neither
parent nor child wrote into the installation.

The archive listing contained only `bin`, the built CLI, its templates, and the
built web distribution. It did not smuggle source `.agents`, `.claude`,
`.codex`, or `scripts` directories into the installed result.

### Repository-bound points exercised

The probe replaced the relevant bindings in `packages/cli/src/launch.ts`: its
module-relative `repositoryRoot`, `refreshMain` of Uberblick's `origin/main`,
Uberblick worktree creation, and fixed `.agents/roles/<role>.md` lookup. The
prototype instead resolved only the explicit project's launch manifest and
started the runtime in that control tree. It deliberately did not reuse the
repository-bound queue probe, branch claims, or standing relaunch loop.

The payload came from `scripts/build-install-payload.mjs`, so the experiment
also crossed the production installation boundary that omits the agent trees
and hides today's `ub launch` command from installed help. Project-local MCP
was provisioned through the shipped `ub mcp install` and served through the
installed bundle, not through `mise x` or a source-tree runner.

### Control and candidate remain separate

The candidate was passed as an additional accessible directory; it never
became the runtime's project directory. The Claude parent discovered its agent
under project A's `.claude/agents`. Its Codex child ran with `-C` set to A's
control tree and `--add-dir` set to A's candidate, while its initial prompt
named the control role contract because Codex does not select the TOML adapter.

The Codex parent similarly stayed rooted in B's control tree. It launched its
Claude child in the foreground and waited for it; that subprocess's working
directory was B's control tree, so `--agent probe-reviewer` discovered the
control adapter even though the added candidate held an adapter with the wrong
marker. Both candidate `git status --porcelain` readings were empty after the
children exited. Agent files entered neither candidate diff.

This is the portable part of the repository's existing reviewer transport
boundary: the control tree supplies instructions and the runner; the candidate
tree supplies code to inspect. A candidate's absence of agent files, or its old
copy of them, cannot choose the reviewer's instructions.

### MCP registration and permissions

Before registration, neither disposable project had `.mcp.json` or
`.codex/config.toml`; copying the workflow files did not provision MCP. The
installed payload then ran these from each control root:

```sh
ub mcp install claude --project --workspace <workspace-uuid>
ub mcp install codex --project --workspace <workspace-uuid>
```

The commands wrote project-local entries for `ub mcp serve` with only
`WORKSPACE_ID` pinned. All four sessions in the functional run called
`sync_status` and returned that UUID. Runtime databases and Uberblick
configuration were redirected into each project's ignored `.runtime/`
directory, so the calls neither contended with nor wrote to the user's
Uberblick replica.

Codex needed normal configuration discovery for project MCP. Passing
`--ignore-user-config` removed the configured server. The project-owned launch
manifest selected `danger-full-access` and the command supplied an explicit
trust override; the source-hidden control additionally bounded that access
with an outer mount namespace. No run used Codex's combined approval-and-sandbox
bypass flag. Claude used `permission-mode auto`, project-only settings, and
non-persistent conversations. Project A's parent received its one runner grant
through the launch data as an explicit `--allowedTools` argument because an
untrusted Claude project ignores `.claude/settings.json` permissions.

## Disproved assumptions and concrete failures

- Project-local settings do not imply user-config-neutral launch. Claude wrote
  project records with `hasTrustDialogAccepted: false`; Codex wrote
  trusted-project records. Hashes of both user files changed during the final
  fixture run.
- Isolating the runtime homes is not a free repair. A fresh
  `CLAUDE_CONFIG_DIR` reported `loggedIn: false` because this machine's OAuth
  credential belongs to the normal Claude config directory. The spike did not
  copy or link credentials. A separate Codex credential/state layout was not
  tested.
- Making the source checkout unreadable with a Linux mount namespace did not
  produce a passing matrix. The installed CLI and both parents launched from
  `/srv` and `/opt/evidence`, while `/tmp` and the source parent were replaced
  by empty mounts. Claude's project MCP worked, but both Codex sessions lacked
  `sync_status` even though `ub mcp install codex --project` had created each
  project's `.codex/config.toml`. This source-hidden observation failed before
  both children could complete.
- Codex's ordinary workspace sandbox could not initialize inside that outer
  namespace on this host. The prototype's `danger-full-access` setting avoided
  nested user-namespace setup, but did not repair project-MCP discovery. It is
  evidence tooling for the outer isolation control, not a recommended launch
  default.
- Project instruction files supply neither the MCP workspace binding nor an
  execution grant. MCP needed both `ub mcp install` calls, and the untrusted
  Claude project ignored its checked-in `permissions.allow` rule.
- Codex adapter presence is not adapter loading. The Codex prompt, not its
  adapter file, carried the selected role contract in this prototype.

## Untested limitations

- The prototype starts one bounded session. It does not implement the standing
  queue loop, probe pacing, signal semantics, recovery, or condensed result
  output of today's repository-bound `ub launch`.
- The two projects used one workspace UUID so the run could prove pinning with
  read-only calls and no product-data mutation. Separate workspaces and multiple
  MCP labels were not needed for the control/candidate question.
- Accepted interactive trust, API-key authentication, and an owner-chosen
  split between credential storage and per-project mutable runtime state were
  not tested.
- Update conflicts, edited workflow files, registries, signing, Windows/macOS
  path behavior, several workflows in one project, and unattended long-running
  loops remain outside this spike.
- The experiment covers two current runtimes and two cross-runtime paths. It
  does not define a generic inheritance system or transport-neutral subagent
  protocol.

## Smallest next implementation shape

Do not implement production launch until the two failed boundaries have named
contracts. If the owner chooses to continue, the narrow shape is:

1. `ub agents install <workflow>` installs a versioned, project-owned workflow
   manifest, role contracts, runtime adapters, permission rules, and MCP
   registration instructions. The workflow defines roles and policy; the
   generic CLI validates and transports them but does not choose work or embed
   Uberblick's queue rules.
2. `ub agents launch <role> [--model claude|codex] [--project <dir>]` resolves
   only the selected control root, starts the runtime there, and never derives
   a source repository from installed module paths.
3. Candidate inspection remains a separate internal launch input. Every
   delegated runner keeps `cwd`/`-C` on the control tree and supplies the
   candidate through `--add-dir`; the Codex prompt names the control contract,
   and Claude's `--agent` resolves from that same control tree.
4. The owner chooses, per runtime, whether one documented interactive trust
   step is required, a user-level project record is accepted, or credentials
   and mutable project state are explicitly separated. The CLI must not copy
   credentials or claim that project files alone grant execution.
5. Before production code, a reduced installed-payload test proves that Codex
   `exec` discovers a project-local MCP server with the source tree hidden. A
   launcher should not compensate for that failure by granting an unbounded
   sandbox without a separate security decision.

This remains compatible with Product requirements' current non-goal only in
the narrow reading authorized for the experiment: Uberblick supplies a generic
launcher for an optional workflow a project chooses; the workflow, not
Uberblick, organizes and runs that project's agents. Publishing Uberblick's
own workflow as a ready-made package remains a later owner decision.

Optional `--auto-update` needs a declared workflow identity, source and version,
an integrity/authenticity check, and a conflict rule for locally edited files.
It also needs a defined check moment and an atomic failure mode that never
replaces a working workflow with a partial one. This spike chooses none of
those; silent replacement or a generic cache would outrun the evidence.
