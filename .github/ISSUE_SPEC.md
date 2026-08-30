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
Parent: #486
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
- **`Parent`** — optional, at most one line, directly after `Touches`. Grammar:
  `^Parent: #[0-9]+$`. It is the reservation relation, and the only one: while
  the named issue is open, this child belongs to that program — only that
  program dispatches it, and global implementer pickup excludes it. Closing the
  parent releases the child; reopening it reserves the child again. A parent
  body's list of children is reading order for a human, never the authority; the
  headers on the children are. No line at all means unreserved, which is the
  ordinary case.

  Anything else **fails closed**: more than one `Parent` line, one naming an
  issue that does not exist or cannot be read, a self-reference, or a cycle
  through parents makes the child dispatchable by *no* role until a human fixes
  the header. That is a header defect — say so in a comment and move to the next
  candidate; never guess which parent was meant. (A delegated subagent's
  `Parent: <role> <run id>` claim comment is a different record in a different
  place, and is not this header.)

### Scheduling semantics

- **Eligible** = labeled `ready` AND every `Depends-on` issue is closed AND
  not claimed AND not reserved by an open `Parent`.
- **Work in flight** is counted in **distinct work units**, reconstructed from
  GitHub: one unit per item, whether that item is a live claim, an unmerged PR,
  or both at once — an unmerged PR and the claim that produced it are one piece
  of work in flight, not two. The cap is 6: when the count is 6, no new issue is
  dispatched until one leaves it. Unmerged PRs occupy their slots first, because
  a PR cannot withdraw and a claim can.
- **A claim is tentative until it is recounted.** Observing the count before
  claiming does not admit you, because a concurrent claimer observed the same
  number. After posting the claim, re-read GitHub and count the units again with
  your own now among them. A successful claimant posts exactly
  `Admitted: N/6 work units.` and no constituent-unit narration. Over the cap,
  the earliest units by the claim order
  `.agents/roles/README.md` defines keep their slots, and every later claimer
  posts a one-line withdrawal and stops — before creating a branch or worktree,
  and before editing anything in the repository. Two claimers that admitted
  themselves on the same reading therefore resolve deterministically instead of
  both proceeding. A fix-up PR already occupies its unit and needs no admission
  recount.
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
  number. An unset value sorts as Medium; it does not make prepared work
  ineligible. The product owner owns every explicit Priority value. Agents may
  report evidence that the order looks wrong, but never write the field.

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
| `needs-preparation` | Queued for one issue-preparer pass | Human or intake template |
| `ready` | Spec-complete; the loop may claim it | Human, or issue-preparer after one-pass clearance |
| `in-progress` | Claimed; branch named in a comment | Loop |
| `needs-decision` | Parked on a question only a human can answer | Loop |

There is deliberately **no `blocked` label**: blocked is derived from
`Depends-on` plus issue closed-state, and stored copies of derivable state
rot.

Preparation is one foreground issue-preparer run. A narrowly mechanical, local,
understood and easily reversible issue gets a code-grounded self-check and no
adversary. Every other issue gets exactly one fresh issue-adversary subagent,
preferably from the other runtime/model; the same preparer applies correctable
findings and sets `ready` when recorded owner-approved authority covers the
result. Unresolved product, agent-authority, safety or fundamentally unsafe-shape
findings take `needs-decision`. Another adversary is exceptional and requires an
explicit owner request, never an automatic preparation loop.

Preparation may instead end in `split`. Technical decomposition is preparer
judgment; decomposition that chooses product behavior is an owner decision.
Thousands of hand-written changed lines are a strong presumption to split, and
an exception must be justified in the prepared issue. The source becomes a
coordination-only parent: remove `needs-preparation`, never add `ready`, and
close it after its required children. Create each independently reviewable
child with `needs-preparation`, `Parent: #N`, and only real ordering
dependencies.

`needs-decision` exit path: the preparer asks one focused question as an issue
comment, with concrete options and its recommendation, and replaces
`needs-preparation` or `ready` with `needs-decision`. A direct answer from the
product owner to that question is authority. Another person's comment is
evidence unless the owner explicitly adopts it; an off-GitHub owner answer may
be recorded only with clear provenance. Once the answer is durable, replace
`needs-decision` with `needs-preparation`. A fresh preparer assignment reuses
the previous handoff, adversary verdict, question and answer, and rechecks only
the affected grounding and intervening upstream changes. It does not repeat
classification or run another adversary by default.

A top-level implementer returns a stale, unsafe, unnecessarily complex, or
owner-bound contract with this issue comment:

```text
Returned: implementer <opus|codex> <session-or-agent id>
Grounding: <origin/main SHA>
Reason: <stale-contract|unsafe|unnecessary-complexity|owner-decision> — <one sentence>
Evidence: <URL or concise pointer>
```

The first consecutive return since the latest product-owner answer to a return
question removes `ready` and `in-progress` and adds `needs-preparation`. Its
preparer reuses the prior pass and refreshes only the affected contract and
grounding; another adversary is not the default. A second consecutive return
removes `ready`, `in-progress` and `needs-preparation`, adds `needs-decision`,
and appends one focused question with concrete options and a recommendation. A
return already at an owner boundary may take that path immediately. The answer
to that question resets the return count. Thus an issue gets at most one
automatic `ready` → `needs-preparation` → `ready` repair cycle before human
escalation.

### Claim protocol

The cross-agent workflow lives in [`AGENTS.md`](../AGENTS.md). Its minimum
durable records use this issue grammar. On claim, add `in-progress` and post:

```text
Claimed: feat/mcp-server
Implementer: opus a12a538d
```

`Implementer` is `<opus|codex> <session-or-agent id>`. Completion is a PR body
recording the outcome, verification, material findings, and KISS/overtesting
self-review. A fix-up claim is posted on the PR:

```text
Claimed: <existing branch>
Implementer: <opus|codex> <session-or-agent id>
Ruling: <integrator comment URL>
```

After opening or updating the PR, post only:

```text
Done: implementer <opus|codex> <session-or-agent id>
Grounding: <origin/main SHA>
```

The PR supplies the branch, head SHA, diff and check state; do not copy them
into the handoff or add a second completion comment to the issue. Recovery and
independent-review rules live only in `AGENTS.md`.

The executable routing detail lives under `.claude/skills/next-issue/`: it owns
the grounded trivial-vs-challenged classification, challenge questions, recheck
and focused parity test. This spec owns only the authority and lifecycle above;
do not grow a second copy of that procedure here or in `AGENTS.md`.

## Body sections

Five required `##` headings after the header. The bar for all of them:
**would the implementing agent have to make a product decision the issue
doesn't answer? Then the issue is not `ready`.**

- **What** — one paragraph, the outcome in behavioral terms.
- **Why** — a sentence or two, tied to the spike acceptance criteria or a
  doc. Keeps the agent from "improving" beyond intent.
- **Acceptance criteria** — a short checkbox list (`- [ ]`) of **distinct,
  observable and non-obvious outcomes or invariants**. Use one to five; regroup
  or split when the contract needs more. State what must be true, not how to
  prove it: unit/e2e scenarios, test files and implementation steps belong in
  Pointers, not in checkboxes. Repository hygiene and delivery gates — lint,
  typecheck, the general test suite, review and CI — already live in
  `AGENTS.md`, `CLAUDE.md` and CI; they are never issue acceptance criteria.
  A post-merge corpus update sequenced by `CLAUDE.md` is not a diff acceptance
  criterion either; point the coordinator to the document under Pointers.
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

A human request may become a coordination-only parent with several bite-sized
children. One `ready` implementation child describes at most one independently
reviewable PR; each PR closes its child, and the parent closes after its required
children. Parents live outside the preparation and implementation queues — only
their children carry `needs-preparation` or `ready`.

The exception runs the other way: individually-trivial issues declaring the
same `Touches` set may be implemented by one agent as one PR closing several
(`Closes #a, #b`), provided the combined diff is still reviewable in one
sitting, the gate check above is applied to that combined diff against the
shared set, and the PR carries the tier-2 merge report of CLAUDE.md's merge
policy, checking each issue's acceptance criteria separately — a batch PR
carries that report even where it would otherwise be tier 1.

### Body length, and what a body is for

An issue body records the **final contract**, not the history of arriving at
it. Material review corrections, superseded decisions and decision chronology
belong in **comments** — searchable, and out of the way of the person
implementing. Do not copy the original intake verbatim into a new comment after
preparation; preserve its material intent in the final contract and rely on the
issue's edit history for the raw draft. Targets, not lint rules, because
judgement beats a character count:

| Kind | Target |
|---|---|
| ordinary leaf | as short as complete, normally under 3,000 characters |
| complex or security-sensitive leaf | normally under 6,000; past that, justify or split it |
| parent | under 3,000 characters |
| acceptance criteria | usually 1–5 distinct outcomes |

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
3. `Parent`, where present, occurs once, matches the grammar, and names a
   readable issue that is neither this one nor a cycle through parents.
4. All five `##` sections present: What, Why, Acceptance criteria,
   Out of scope, Pointers.
5. At least one `- [ ]` checkbox under Acceptance criteria.
6. Out of scope and Pointers are non-empty (explicit `None.` is acceptable).

Sizing and decision-completeness are judgment calls, not lintable — the
issue-preparer applies them when granting `ready`, and any role that finds a
`ready` issue failing them says so and skips it.
