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
  short names of directories under `packages/` (currently `cli`, `hub`,
  `mcp-server`, `schema`, `web` — the live directory listing is authoritative,
  this sentence is not), plus `repo` (root config, CI, top-level docs).
  Grammar: `^Touches: [a-z0-9-]+(, [a-z0-9-]+)*$`, every name from that list.

### Scheduling semantics

- **Eligible** = labeled `ready` AND every `Depends-on` issue is closed AND
  not claimed.
- **Work in flight** is the count of claimed issues plus unmerged PRs,
  reconstructed from GitHub. It is capped at 6: when the count is 6, no new
  issue is dispatched until one leaves the count.
- Parallelism is judged at **file** level, not `Touches`-set level: overlapping
  `Touches` sets do not by themselves queue. From the issues' scope and
  Pointers the loop forms an expectation of which files each will edit.
  Dispatch in parallel when substantive implementation files are expected to
  be disjoint. A bounded predicted overlap is also allowed in purely additive
  aggregation surfaces, such as barrel exports or files collecting independent
  error types, when reconciling it is mechanical; the later branch rebases after
  the earlier merge and every exact-head gate runs again. Semantic overlap, or
  files that cannot be foreseen with confidence, queue. An expectation that
  proves wrong has the same rebase and fresh-gate consequence.
- This includes `schema`: its keystone risk is paid by exact-head review and
  gates after any rebase, not by locking unrelated files or packages.
- Order among eligible issues: dependency topology, then **`Priority`** — the
  organization issue field, Urgent → High → Medium → Low — then ascending issue
  number. An issue whose `Priority` field is unset is *untriaged* and ineligible
  for every role's pickup; `Urgent` is set only by the owner.

`Priority` is that field, read through the API — never a line in the issue body:

```sh
gh api graphql -f query='query{repository(owner:"uberblick-ai",name:"uberblick-2"){issue(number:N){issueFieldValues(first:10){nodes{... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}}}}}'
```

Take the node whose `field.name` is `Priority`; its `name` is the value.

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

The cross-agent workflow lives in [`AGENTS.md`](../AGENTS.md). Its minimum
durable records use this issue grammar. On claim, add `in-progress` and post:

```text
Claimed: feat/mcp-server
Implementer: opus a12a538d
```

`Implementer` is `<opus|codex> <session-or-agent id>`. Completion is a PR
comment recording what changed,
how it was verified, unresolved blockers, risks, or findings, and the
KISS/overtesting self-review. Head SHA, check state, and timing remain derived
from the PR rather than copied into the durable record. Recovery and
independent-review rules live only in `AGENTS.md`.

What comes *before* a claim — the preflight tier table that decides how hard to
challenge an issue, and its executable twin under
`.claude/skills/next-issue/` — is deliberately not here and not in `AGENTS.md`.
The ladder is Claude-loop machinery by design: `AGENTS.md` states that each
coordinator's own procedure owns it, and `.agents/skills/next-issue/SKILL.md`
is a Codex entry stub pointing back at `AGENTS.md`, not a second copy of that
procedure. A future pass should not "fix" the asymmetry by hoisting the table
into this spec.

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
  (b1d5d904-c8b6-46a1-a4df-22251875bcdb)"; `list_docs` against the live
  workspace is the authoritative — and only — source of a uuid. The repository
  holds no copy of the corpus and no uuid table. Cite, never restate: the agent
  reads the doc itself at dispatch, so a pointer that copies its content only
  ages. `None.` only when CLAUDE.md genuinely
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
3. All five `##` sections present: What, Why, Acceptance criteria,
   Out of scope, Pointers.
4. At least one `- [ ]` checkbox under Acceptance criteria.
5. Out of scope and Pointers are non-empty (explicit `None.` is acceptable).

Sizing and decision-completeness are judgment calls, not lintable — the
coordinator applies them when granting or revoking `ready`.
