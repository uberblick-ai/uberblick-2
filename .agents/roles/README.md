# Role contracts

Six roles carry the development cycle: `issue-preparer`, `issue-adversary`,
`implementer`, `implementation-reviewer`, `integrator`, `program-coordinator`.
Each file beside this one is the canonical contract for one role, and
`.claude/agents/` and `.codex/agents/` hold thin adapters that point back at it.
This file states what every role obeys, so no contract repeats it.

The product reasoning behind the role split lives in the corpus, in General
Agent Workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`). The contracts cite it
by uuid and never restate it.

#460's broader authority model is pending repository migration: `AGENTS.md`,
`CLAUDE.md` and `.github/ISSUE_SPEC.md` win on conflicts; installing these
descriptions starts no worker and grants no merge authority.

## One assignment, from an invoker

A role acts on one bounded assignment supplied by its invoker, carrying the
identifiers the work needs: the issue or PR URL, the role and the session or
agent id acting, and the branch and head SHA wherever the outcome is tied to a
revision. Missing assignment or missing identifiers is a refusal, stated before
any side effect — no guessing at scope, no selecting work of its own.

Bounded means one outcome and one stopping condition, not one attempt:
investigating, correcting and retrying inside the assignment is the work. The
role retrieves only the context that assignment needs and stops when its durable
record is written. An invoker that resumes a role after accepting its handoff
has voided this contract — the next assignment starts a fresh session.

## Where truth comes from

- **GitHub is execution state.** Claims, scope, dependencies, evidence,
  findings, dispositions and merge state. Recovery must be possible from GitHub
  alone.
- **Uberblick is product context.** Behavior, intent, limits and the reasoning
  behind decisions, read through the Uberblick MCP tools.
- **Repository guidance is the active authority.** `AGENTS.md`, `CLAUDE.md` and
  `.github/ISSUE_SPEC.md` are executable rules and win on conflicts with
  anything here or in the corpus.

## The corpus must be reachable

Before any side effect the role reads its product context through the Uberblick
MCP tools and treats the corpus as reachable only when `sync_status` reports
`hub.status: "connected"` **and** every room it read reports `synced: true`. A
server can serve a stale replica while refusing to sync, so a successful
`get_doc` alone proves nothing.

Otherwise the role stops with an **unreachable-corpus report**: the assignment,
its role and session identity, the workspace, the hub status with its reason and
url, the uuids it needed, an explicit statement that no side effect occurred,
and the recovery action. A role that cannot read the corpus cannot know what
already binds it, so inference is never the fallback.

## Decisions outlive their issue; dispositions do not

One test: **does this choice still bind anything once the issue closes?**

- **No** — it is task-scoped. Decide it, record it where the role's completion
  record belongs, and let it die with the issue.
- **Yes** — it is not a disposition. The role creates a `decision`-tagged
  Uberblick document opening `Open decision — <question>`, carrying the question,
  the options weighed, the reasoning and the trigger that would revive an
  alternative, and **no answer**. It reports the document in its handoff and
  stops. The owner answers; an agent never settles a product question by
  disposing of a finding about it.

## Delegation and authorship

Delegating a bounded subtask is allowed and stays bounded — the delegating role
still owns the outcome and the durable record. A context reset never erases
authorship: the author of a diff is never its independent reviewer, however
fresh the session that reads it.
