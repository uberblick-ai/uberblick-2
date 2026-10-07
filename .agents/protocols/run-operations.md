# Run operations

Read the relevant section before posting records, creating scratch or follow-up
issues, starting a process, or working in a checkout. The shared
[role core](../roles/README.md) and the assigned role bound all these actions.

## Posting records and scratch

Supervised retrospective posts use [the launcher route](retrospectives.md).
Post other comment bodies from files (`gh ... --body-file`), and update a mutable
record by its immutable comment id (`gh api ... -F body=@<file>`), never "edit
last". Preserve literal text and newlines. Confirm scratch-file writes
succeeded before posting; noclobber can leave stale content.

Each run uses fresh private scratch outside the worktree, namespaced by its run
id: put `$UB_AGENTS_RUN` in the name of every temp directory you create. Never
share scratch or treat it as durable state. The project cleanup hook covers only
private-worktree runs (implementer and PR reviewer). Scratch from shared
operator-checkout runs (issue preparer, issue reviewer and integrator), and that
checkout's shared Claude task directory, are left to the operator.

## Follow-up issues

Before creating a follow-up issue discovered during a run, fetch `origin/main`
and check the observation against that commit and existing open issues. Do not
queue work that the current base already resolved or already tracks. Create it
with `gh issue create --repo uberblick-ai/uberblick-2` and no labels, adding
`--blocked-by` or `--parent` only for a real relationship, and leave Request
Source unset. A maintainer starts it by adding `needs-preparation`. A trigger
label set by a run is not a start: ub-agents parks the issue for a human instead.

Priority authority is defined in
[workflow.md](workflow.md#priority).

## Request Source

`Request Source` is statistical provenance, never a gate. Use `Human` when the
outcome originated with a person, even if an assistant files it; use `Agent`
for an agent-discovered follow-up, review finding, audit item, split or program
child. Backfill only from durable origin evidence, never the GitHub author alone.

Agents create issues with `gh issue create` and leave this field unset; a human
may set it in the sidebar. Missing values never block preparation, implementation
or merge.

## Effort field

The preparer may set or revise only the assigned issue's existing `Effort` field
under [issue-preparation.md](issue-preparation.md#decide-the-work-shape-and-route).
Discover its current integer ID and options rather than guessing a label or a
project field:

```sh
gh api orgs/uberblick-ai/issue-fields --jq '.[] | select(.name == "Effort") | {id,data_type,options: [.options[].name]}'
```

Require the existing single-select field and the chosen XS/S/M/L/XL option.
Using the discovered ID and option name, write a private JSON body with one entry
in `issue_field_values`, containing the integer `field_id` and string `value`.
Use `gh api --method POST` on
`repos/uberblick-ai/uberblick-2/issues/<N>/issue-field-values` with `--input`
pointing to that body file. Use POST, not PUT (which replaces all field values),
and never send an empty array. Read the same endpoint with GET and check Effort's
`single_select_option.name` matches the estimate. See
[GitHub's field-value API](https://docs.github.com/en/rest/issues/issue-field-values#add-issue-field-values-to-an-issue).

If discovery or writing fails, report the concrete failure; do not invent a
replacement field or change field definitions, visibility, permissions or priority.

## Every process a run starts is that run's to end

A run owns each process it spawns on the host — a browser, a load or timing
probe, a server, a watcher — until that process exits. Start one in the
foreground of a script under a cleanup trap so that an interrupted run still
tears it down, and give it its own deadline (a `timeout`, or the tool's own
equivalent) so it dies on its own clock rather than waiting on a parent that may
never return. Never disown a process to make it someone else's problem.
A trap only runs between commands, so a loop that blocks in a foreground
`sleep` will not honour `SIGTERM` until that sleep ends: background the wait
and `wait` on it, or signal the process group, or the trap is decoration.

A run ends when its session ends, so a task your agent tool starts in the
background never reports back. Wait in the foreground with a bounded command, such as `gh pr checks <N>
--watch` under the tool's timeout. A tool that returns while the command still
runs leaves it yours: keep polling until it exits, or stop it. When what you
wait for is still pending after that, finish `defer` and name it.

## Worktrees

Work in the directory and on the branch the run was given; ub-agents creates
and removes them. Push only that branch, or the branch of the earlier run's
pull request you continue. Never rebase or force-push a pull request's head;
the one exception is an integrator's single published clean base refresh per PR
under [integration.md](integration.md), with an explicit expected-old-head lease and
the automatic implementer and review handoff. An integrator in the shared
operator checkout makes that refresh only in the private scratch clone
`integration.md` specifies, and pushes the PR's assigned remote branch, never
the operator checkout's branch. A detached checkout is pushed with `git push origin
HEAD:refs/heads/<branch>`. Leave other runs' worktrees and
processes alone.
