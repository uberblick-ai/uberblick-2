# Role contracts

Shared rules for the four delivery roles. Each role file says what its run is
given, what it does and which outcomes it may end with. The issue schema lives
in `.github/ISSUE_SPEC.md`, executable gates in
`.agents/protocols/delivery-policy.md`, product intent in the MCP corpus.

## One run, one item, one outcome

A run is given one issue or pull request — for a pull request, also the head it
works at — and works only that item. It ends with exactly one outcome its role
file lists, plus a short summary: what was decided or changed, the grounding
commit, and links to evidence. That summary is the handoff, so it carries what
the next run needs and nothing it can read from GitHub itself.

Workflow state is not the run's to write. The table below is this
repository's workflow, and ub-agents applies it: it moves the labels, posts the
handoff, records which runtime did the work, and ensures only one run holds an
item at a time. A role never changes a workflow label on an existing item,
posts a claim, or starts the `agent` review itself. Optional Copilot requests
follow `.agents/protocols/delivery-policy.md`. What the task produces is the
run's to write: issue bodies and relationships, commits and pull requests,
findings, the merge, corpus updates and new issues.

Each role starts on its label: the preparer on `needs-preparation`, the
implementer on `ready` (an issue) or `needs-changes` (a pull request), the
reviewer on `needs-review`, the integrator on `ready-to-merge`. Every outcome
except `defer` removes that label and adds the next one:

| Role | Outcome | Label changes |
| --- | --- | --- |
| issue-preparer | `ready` | issue: `needs-preparation` → `ready` |
| issue-preparer | `review` | issue: `needs-preparation` → `needs-review` |
| issue-preparer | `split` | issue: `needs-preparation` removed; its sub-issues wait, unlabelled, for a maintainer to add `needs-preparation` |
| issue-preparer | `wontfix` | `needs-preparation` removed; the run has closed the issue as not planned |
| implementer | `review` | its pull request gets `needs-review`; the issue loses `ready`, or the pull request `needs-changes` |
| implementer | `integrate` | its pull request gets `ready-to-merge`; the issue loses `ready`, or the pull request `needs-changes` |
| implementer | `returned` | issue runs only: `ready` → `needs-preparation` |
| reviewer (issue) | `approve` | `needs-review` → `ready` |
| reviewer (issue) | `changes` | `needs-review` → `needs-preparation` |
| reviewer (pull request) | `approve` | `needs-review` → `ready-to-merge` |
| reviewer (pull request) | `changes` | `needs-review` → `needs-changes` |
| integrator | `merged` | pull request merged; `ready-to-merge` removed |
| integrator | `changes` | `ready-to-merge` → `needs-changes` |
| integrator | `review` | `ready-to-merge` → `needs-review` |
| any | `needs-human` | the role's label → `needs-human` |
| any | `defer` | reported as a retry, not an outcome: no label changes, and the item runs again later |

The reviewer runs as two configured agents, one per item kind, sharing
`reviewer.md`. `needs-human` pauses the item: no run picks it up while the label
is there. The person who answers replaces it with the label that should run
next — `needs-preparation` on an issue, `needs-changes` on a pull request —
unless the answer calls for another.

`ub-agents.yaml` declares these label transitions and the queue policy in
`.github/ISSUE_SPEC.md` for ub-agents to apply.

## Preserve the shaped scope

Delivery roles preserve the scope confirmed in shaping and its essential
guarantees: add no optional capability because it is convenient, and drop no
agreed behavior in the name of an MVP. Fill factual gaps from evidence, make
engineering choices within scope, and escalate unresolved owner choices.

## Escalate what is not yours to decide

For implementation within an already approved issue that meets an open
decision, follow [the implementer's bounded exception](implementer.md#build-on-an-open-decision).
All other boundary crossings follow the escalation rule here.

Decide what the issue, settled decisions, adopted principles and repository
policy already cover. Ask a person when the next step would change product
direction, an adopted principle or guarantee, external resources or agent
authority (the **human boundaries**); when the merge policy says tier 3; or
when review stops converging. A correctable gap in a specification is not such
a stop: correct it.

Finish `needs-human`. The summary is the question, ready to answer:

- what is blocked, and each independent decision needed;
- the answers to pick from, and your recommendation;
- an @-mention of who can answer: the person who opened the issue (for a pull
  request, its issue) when they have write access, otherwise
  `@uberblick-ai/maintainers`;
- the closing line `Answer here, then replace needs-human with <label>.`,
  naming `needs-preparation` on an issue or `needs-changes` on a pull request.

Put the question before the evidence: each independent decision as its own
numbered item, in one or two plain sentences naming the choice, what each
answer means for the person, and the recommendation. Keep material risks, the
@-mention and the closing line visible; put commits, CI results and resume
mechanics in a collapsed `<details>` block or a linked record. When the
launcher flattens Markdown or the explanation is long, post a structured
decision comment, link it from the summary and repeat the closing line there.
Launcher-generated resume steps apply only when the same role should resume.

Any person with write access may answer. A comment from a person's account is
the answer; one from `uberblick-agent` or a bot never is. The next run works
within it. An answer covers what it names, plus fix-ups that conform to it;
anything beyond that is a new question.

## Limits for every run

Only the integrator merges. No run enables auto-merge, approves its own pull
request, changes branch protection or repository settings, pushes a tag or
publishes a release. A blocked operation is never worked around by copying
credentials, changing global settings or disabling commit signing: escalate or
defer with the evidence.

## Authorship

Delegating a bounded subtask is allowed; the delegating run still owns the
outcome and the record. A context reset never erases authorship: the author of
a change is never its independent reviewer.

## Records

Post comment bodies from files (`gh ... --body-file`), and update a mutable
record by its immutable comment id (`gh api ... -F body=@<file>`), never "edit
last". Preserve literal text and newlines. Confirm scratch-file writes
succeeded before posting; noclobber can leave stale content.

Each run uses fresh private scratch outside the worktree, namespaced by its run
id: put `$UB_AGENTS_RUN` in the name of every temp directory you create. Never
share scratch or treat it as durable state. The project cleanup hook covers only
private-worktree runs (implementer and PR reviewer). Scratch from shared
operator-checkout runs (issue preparer, issue reviewer and integrator), and that
checkout's shared Claude task directory, are left to the operator. A private
transcript is never a handoff: GitHub must be sufficient for a fresh run to continue.

Before creating a follow-up issue discovered during a run, fetch `origin/main`
and check the observation against that commit and existing open issues. Do not
queue work that the current base already resolved or already tracks. Create it
with `gh issue create --repo uberblick-ai/uberblick-2` and no labels, adding
`--blocked-by` or `--parent` only for a real relationship, and leave Request
Source unset. A maintainer starts it by adding `needs-preparation`. A trigger
label set by a run is not a start: ub-agents parks the issue for a human instead.

Priority is the `priority:urgent|high|medium|low` label. A person owns every
value; agents never set one by their own judgement. The one agent write is a
shaping session recording the value the person stated.

## Retrospectives

Post one to your role's board (`AGENTS.md`, Project facts) only when the run
lost something real — an extra session or review round, rework, or about fifteen
minutes of discovery — or missed something it needed, such as a corpus document,
a pointer or a check, and only when you can say why and name the change that
would have prevented it. Otherwise post nothing, and post at most once per item:
a retry does not repeat what an earlier run of yours already posted. In a short
paragraph, link the item, state the cost and its cause, and the smallest useful
change. The boards are public: never include credentials, environment values,
local paths, hostnames or log excerpts. Write the body file in private scratch,
never the worktree, where it could be committed. A
retrospective is telemetry, never a gate.

## Every process a run starts is that run's to end

A run owns each process it spawns on the host (a browser, a probe, a server, a
watcher) until it exits. Start it under a cleanup trap and its own `timeout`,
and never disown it. A trap runs only between commands, so background a long
`sleep` and `wait` on it, or signal the process group. A background task never
reports back after the session ends: wait in the foreground with a bounded
command, keep polling anything still running, and finish `defer`, naming it,
when what you wait for is still pending.

## Worktrees

Work in the directory and on the branch the run was given; ub-agents creates
and removes them. Push only that branch, or the branch of the earlier run's
pull request you continue, and never rebase or force-push a pull request's
head. A detached checkout is pushed with `git push origin
HEAD:refs/heads/<branch>`. Leave other runs' worktrees and
processes alone.

Headless Claude runs deny, without a prompt, any shell command that is not on
the allow list as written: shell expansion (`$VAR`, `${VAR}`, `$?`, `$(...)`,
backticks) and loops (`for`, `while`) are denied even when every command inside
is allowed. Run one plain command per call instead. Files outside the worktree
and the run's `scratch` directory are not readable; read corpus documents
through the corpus MCP tools.
