# Issue spec — loop-ready issues

The contract for issues the implementation loop may pick up. The loop's triage
step lints against this spec: an issue labeled `ready` that fails any check
below gets a comment listing exactly what's missing, loses the `ready` label,
and is skipped. Bad input is bounced, never interpreted — the loop must not
fill gaps by guessing.

Design principle (same as the repo's data invariants): anything **derivable**
(blocked state, execution order) is computed, never stored; anything **not
derivable** (dependencies, footprint, scope) must be declared.

## Machine-readable header

The first lines of the issue body, before any heading:

```
Depends-on: #2, #3
Touches: mcp-server, schema
```

- **`Depends-on`** — mandatory, even when empty. `none` or a comma-separated
  list of issue refs. Grammar: `^Depends-on: (none|#[0-9]+(, #[0-9]+)*)$`.
  A missing line means *untriaged*, which is different from `none`
  (*consciously independent*); untriaged issues are never eligible.
- **`Touches`** — mandatory. Comma-separated footprint names, lowercase: the
  short names of directories under `packages/` (currently `hub`, `mcp-server`,
  `schema`, `web` — the live directory listing is authoritative, this sentence
  is not), plus `docs-seed` and `repo` (root config, CI, top-level docs).
  Grammar: `^Touches: [a-z0-9-]+(, [a-z0-9-]+)*$`, every name from that list.
- **`Priority`** — optional third line. `high`, `normal`, or `low`; absent
  means `normal`. Grammar when present: `^Priority: (high|normal|low)$`.
  A reprioritizing pass edits this line; everything else about order is
  derived.

### Scheduling semantics

- **Eligible** = labeled `ready` AND every `Depends-on` issue is closed AND
  not claimed.
- Parallelism is judged at **file** level, not `Touches`-set level: overlapping
  `Touches` sets do not by themselves queue. From the issues' scope and
  Pointers the loop forms an expectation of which files each will edit, and
  dispatches in parallel (separate worktrees) whenever those are expected to be
  disjoint. Parallel dispatch needs that positive expectation: where the files
  cannot be foreseen with confidence, the issues queue. An expectation that
  proves wrong costs a rebase, not a lost gate: the later PR rebases and its
  gates re-run at the new head, which the commit-keyed gate rule already
  requires.
- `schema` in `Touches` **serializes globally** — it is the keystone package;
  nothing else is dispatched while a schema-touching issue is in flight.
- Order among eligible issues: dependency topology, then `Priority`
  (high → normal → low), then ascending issue number.

### Gate check

`Touches` is a declared claim, verified at review time: the PR diff must stay
within the declared footprint. A diff that escapes it is a finding — either
the issue was mis-scoped or the agent scope-crept. The resolution is explicit
(fix the scope or re-declare), never silent.

## Labels — lifecycle

| Label | Meaning | Set by |
|---|---|---|
| *(none)* | Draft — invisible to the loop | — |
| `ready` | Spec-complete; the loop may claim it | Human (or agent with human sign-off) |
| `in-progress` | Claimed; branch named in a comment | Loop |
| `needs-decision` | Parked on a question only a human can answer | Loop |

There is deliberately **no `blocked` label**: blocked is derived from
`Depends-on` plus issue closed-state, and stored copies of derivable state
rot.

`needs-decision` exit path: the loop asks the question as an issue comment
(concrete options, its recommendation). A human answers in a comment; whoever
resolves it removes `needs-decision` and restores `ready` — restoring `ready`
is the assertion that the decision is now written into the issue body, not
just the thread.

### Claim protocol

On claiming an issue the loop adds `in-progress` and comments the branch and
the implementer it dispatched to:

```
Claimed: feat/mcp-server
Implementer: opus
```

`Implementer` names the agent type (`opus`, `codex`) — who wrote the diff has
to be readable without asking, because an implementer never reviews its own
PR authoritatively. The claim comment is written **before** the implementing
agent is prompted: a session that dies between the two must leave the claim
behind, not the work.

Recovery rule: an issue carrying `in-progress` is stale, and may be reclaimed,
when its named branch has no live worktree **and** no open PR **and** the claim
comment is older than 30 minutes. The grace window exists because the claim now
precedes the worktree: without it a parallel coordinator can reclaim an issue in
the seconds between the two writes. Liveness for `Implementer: codex` is the
branch on `origin` or the PR — never a terminal pane, which no other session can
see. Claims live on GitHub, not in any session's memory, so a crashed session
never strands an issue.

The completion handoff is a comment on the **PR**, not the issue: what
changed, how it was verified, and what is unresolved — blockers, accepted
risks, findings left unaddressed. Review happens on the PR, so that is where
the handoff has to be readable; the issue thread carries the claim only. Head
SHA, check state and timing are derived from the PR and never restated here.

## Body sections

Five required `##` headings after the header. The bar for all of them:
**would the implementing agent have to make a product decision the issue
doesn't answer? Then the issue is not `ready`.**

- **What** — one paragraph, the outcome in behavioral terms.
- **Why** — a sentence or two, tied to the spike acceptance criteria or a
  doc. Keeps the agent from "improving" beyond intent.
- **Acceptance criteria** — a checkbox list (`- [ ]`) where **every item is
  verifiable by running something**: a test, a command, an observable
  behavior. "Works offline" fails this bar; "kill the hub, `create_doc`
  still succeeds, restart the hub, the doc appears on a second client"
  passes. This list is what the coordinator validates the PR against —
  vague criteria make the gate unvalidatable.
- **Out of scope** — explicit non-goals, or `None.` if genuinely none. This
  is the "least code wins" principle made enforceable: it is what scope
  creep gets rejected against.
- **Pointers** — where a fresh agent should look before writing anything:
  relevant files/modules, prior PRs and issues, CLAUDE.md sections, product
  docs, and known gotchas (e.g. "y-prosemirror deletes unknown elements —
  see #14"). Cite a product doc as `title (uuid)` — e.g. "Editing and blocks
  (b1d5d904-c8b6-46a1-a4df-22251875bcdb)"; uuids come from `list_docs`
  (authoritative) and from the seed files' frontmatter under `docs-seed/`,
  with a convenience table in `docs-seed/README.md` once #139 lands. Cite,
  never restate: the agent reads the doc itself at dispatch, so a pointer
  that copies its content only ages. `None.` only when CLAUDE.md genuinely
  covers it. Every implementing agent starts with zero session memory; this
  section is what makes that cheap instead of expensive.

## Sizing

One issue = one PR by default, reviewable in one sitting. Work that honestly
needs multiple PRs becomes a parent issue split into loop-ready children;
parents are never labeled `ready`, only their children are.

The exception runs the other way: individually-trivial issues declaring the
same `Touches` set may be implemented by one agent as one PR closing several
(`Closes #a, #b`), provided the combined diff is still reviewable in one
sitting, the gate check above is applied to that combined diff against the
shared set, and the PR carries the tier-2 merge report of CLAUDE.md's merge
policy, checking each issue's acceptance criteria separately — a batch PR
carries that report even where it would otherwise be tier 1.

### Body length, and what a body is for

An issue body records the **final contract**, not the history of arriving at
it. Review corrections, superseded designs and decision chronology belong in
**comments** — searchable, and out of the way of the person implementing.
Targets, not lint rules, because judgement beats a character count:

| Kind | Target |
|---|---|
| ordinary leaf | 1,500–4,000 characters |
| complex or security-sensitive leaf | up to 8,000; past that, justify it |
| parent | under 5,000 characters |
| acceptance criteria | 3–8 runnable bullets |

Two consequences worth stating, because both have gone wrong here:

- **Mechanism belongs in a document, not an issue.** When the corpus is
  unreachable and a design lands in an issue body instead, that is a recorded
  debt to repay, not a precedent — see CLAUDE.md's dogfooding contract.
- **A draft carries exactly one unresolved decision** and the
  `needs-decision` label. An issue with several open questions is not a draft,
  it is a conversation; close it until it becomes actionable.

Close a parent when its final child closes.

## Lint — the exact checks

An issue labeled `ready` must pass all of:

1. `Depends-on` line present, first-section, matching the grammar above.
2. `Touches` line present, matching the grammar, every name valid.
3. `Priority` line, when present, matches its grammar.
4. All five `##` sections present: What, Why, Acceptance criteria,
   Out of scope, Pointers.
5. At least one `- [ ]` checkbox under Acceptance criteria.
6. Out of scope and Pointers are non-empty (explicit `None.` is acceptable).

Sizing and decision-completeness are judgment calls, not lintable — the
coordinator applies them when granting or revoking `ready`.
