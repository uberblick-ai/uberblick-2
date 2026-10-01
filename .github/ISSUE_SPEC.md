# Issue spec — ready issues

The contract for issues an implementer may be given. An issue labelled `ready`
that fails any check below is not implementable: the implementer finishes
`returned`, naming exactly what is missing. Bad input is bounced, never
interpreted — no run fills gaps by guessing.

Design principle (same as the repo's data invariants): anything **derivable**
(blocked state, execution order) is computed, never stored; anything **not
derivable** (dependencies, footprint, scope) must be declared, once.

## Relationships

Dependencies and splits are GitHub issue relationships, not body text:

- **Blocked by** — a real ordering prerequisite: this issue cannot be built
  until that one closes. When ordering depends on an open PR, the issue is
  blocked by the issue that PR closes. If the PR closes no issue, record the
  overlap in Pointers and let the file-overlap rule queue it instead of
  inventing a dependency. Set it with `gh issue create --blocked-by` or
  `gh issue edit --add-blocked-by`.
- **Sub-issue** — the split relation and nothing else: this issue is one piece
  of that parent. Set it with `gh issue create --parent` or
  `gh issue edit --parent`. Being a sub-issue never affects eligibility, and
  order only through the priority rule below (owner decision, 2026-09-04,
  after reserved children sat `ready` for days with nobody able to dispatch
  them). A parent's list of its pieces is reading order for a person; the
  relationship is the authority.

## Machine-readable header

The first lines of the issue body, before any heading:

```
Touches: mcp-server, schema
Implements: 4f1b7c2e-8a30-4d51-9e6b-2c7a1d55f0a3
```

- **`Touches`** — mandatory. Comma-separated footprint names, lowercase: the
  short names of directories under `packages/` (currently `cli`, `hub`,
  `mcp-server`, `schema`, `web` — the live directory listing is authoritative,
  this sentence is not), plus `repo` (root config, CI, top-level docs).
  Grammar: `^Touches: [a-z0-9-]+(, [a-z0-9-]+)*$`, every name from that list.
- **`Implements`** — optional, and the only header line that may repeat: one
  line per requirement document, the repeated lines contiguous, directly after
  `Touches`. Grammar:
  `^Implements: <uuid>( \[<block-id>(, <block-id>)*\])?$`, the requirement
  document's uuid and optionally the ids of the outcome blocks this issue
  covers. Both are read from the live workspace; the repository holds no uuid
  table. It is what makes retrieval work — "which issues did this requirement
  become" is an `Implements:` search rather than a full-text guess — and it is
  the only line that arms the gate below. A misplaced, malformed or
  non-contiguous line fails the lint below rather than being interpreted; never
  guess which requirement was meant.

  A requirement cited only under **Pointers** stays background reading, with no
  lifecycle and no approval effect: citing a uuid there declares nothing and
  gates nothing.

  **`Implements:` narrows who may hold `ready`.** An issue carrying it holds
  `ready` only while a person has approved the outcomes it names, in a comment
  from their own account on the issue or its parent — never `uberblick-agent`
  or a bot. Approval lives in GitHub, never in a document field any client can
  write, so a requirement's `status` authorizes nothing. Whether the approval
  really covers the outcomes named is a judgment for whoever grants `ready`.

### Scheduling semantics

- **Eligible** = labelled `ready` AND not blocked by an open issue. ub-agents
  skips every other issue.
- Parallelism is judged at **file** level, not `Touches`-set level: overlapping
  `Touches` sets do not by themselves serialize work. When an open pull request
  is expected to edit the same substantive files semantically, the later
  implementer marks its issue blocked by the issue that PR closes and finishes
  `defer`. A bounded predicted overlap in purely additive aggregation surfaces,
  such as barrel exports or files collecting independent error types, is
  reconciled mechanically: after the earlier merge, the later branch
  synchronizes through a non-rewriting merge only if mergeability requires it,
  and every exact-head gate runs again.
- This includes `schema`: its keystone risk is paid by exact-head review and
  gates after upstream reconciliation, not by locking unrelated files or
  packages.
- Order among eligible issues: **effective priority** first — the
  `priority:urgent`, `priority:high`, `priority:medium` and `priority:low`
  labels — then oldest first (ascending issue number). An issue's effective
  priority is the highest among its own, its parent's and every open issue it
  blocks, followed transitively: a medium that blocks a high is picked as a
  high, a sub-issue of an urgent parent as urgent, and the oldest urgent goes
  before any high (owner direction, 2026-09-01). An unset label sorts as
  medium — a person sets one to move an issue, not to admit it — and does not
  make prepared work ineligible. Dependencies otherwise gate eligibility and
  earn no other place in line. ub-agents computes this order; no one writes an
  inherited value onto an issue. A person owns every priority label. Agents may
  report evidence that the order looks wrong, but never set a label on their
  own judgement. The one agent write is a shaping session recording the value
  the person stated in that conversation, with a provenance comment on the
  issue (`.agents/protocols/issue-shaping.md`; owner decision, 2026-09-07).

### Gate check

`Touches` is a declared claim, verified at review time: the PR diff must stay
within the declared footprint. A diff that escapes it is a finding — either
the issue was mis-scoped or the agent scope-crept. The resolution is explicit
(fix the scope or re-declare), never silent.

## Request source

`Request Source` is statistical provenance, never a gate. It is `Human` when
the requested outcome originated with a person — even when an assistant files
it — and `Agent` for an agent-discovered follow-up, review finding, audit item,
split or program child. Do not infer historical values from the GitHub author;
backfill only where durable evidence states the origin.

Agents create issues with `gh issue create` and leave the field unset; a human
may set it in the issue sidebar. A missing value never blocks preparation,
implementation or merge.

## Labels — lifecycle

| Label | Meaning | Set by |
|---|---|---|
| *(none)* | Draft, or a parent after a split — no role runs on it | — |
| `needs-preparation` | Queued for one issue-preparer pass | A person, the intake template, or a run creating an issue |
| `ready` | Spec-complete; an implementer may be given it | A person, or the issue-preparer's `ready` outcome |
| `needs-human` | Parked on a question for a person | Any run's `needs-human` outcome |
| `wontfix` | Low-impact theoretical work closed as not planned | A person, or the issue-preparer's `wontfix` outcome |
| `priority:*` | Order among eligible issues (Scheduling semantics) | A person |

Outcomes move these labels through ub-agents; pull-request labels are ub-agents'
too (`.agents/roles/README.md`).

There is deliberately **no `blocked` label**: blocked is derived from
blocked-by relationships plus issue closed-state, and stored copies of
derivable state rot.

An issue-preparer may close a low-impact theoretical finding as not planned
with `wontfix` when no current supported-usage failure is established and a
delivery cycle is disproportionate. Record the consequence and that rationale.
Never use this route for data loss,
auth or security exposure, or a violated invariant. A concrete bug observed
later is new evidence and may be filed or reopened then.

Preparation follows `.agents/protocols/issue-preparation.md`; the issue-preparer
owns its final verdict. Correctable findings are applied in preparation, and
unresolved owner boundaries are escalated. An issue gets one review pass.

A split follows Sizing below. The source becomes the parent: it leaves the
queues and is never `ready`. Each piece is a sub-issue with
`needs-preparation`, the parent's milestone, and blocked-by relationships only
for real ordering dependencies. Technical decomposition is preparer judgment;
choosing product behavior beyond delegated authority is a person's decision.

`needs-human` on an issue: the run's summary asks one focused question, with
concrete options and its recommendation (`.agents/roles/README.md`). A
person's comment answers it; an agent's comment is evidence unless a person
explicitly adopts it. The person then removes `needs-human`, and the issue
returns to the preparer. That pass reuses the previous handoff, review verdict,
question and answer, and rechecks only the affected grounding and intervening
upstream changes. It does not repeat classification or the review.

An implementer returns a stale, unsafe, unnecessarily complex, or owner-bound
contract with the `returned` outcome, whose summary reads:

```text
Grounding: <origin/main SHA>
Reason: <stale-contract|unsafe|unnecessary-complexity|owner-decision> — <one sentence>
Evidence: <URL or concise pointer>
```

The first consecutive return since the latest answer to a return question
sends the issue back to preparation, and that pass reuses the prior one and
refreshes only the affected contract and grounding; another review is not
owed. On a second consecutive return the preparer finishes `needs-human` with
one focused question, concrete options and a recommendation. A return already
at an owner boundary may take that path immediately. The answer to that
question resets the return count. Thus an issue gets at most one automatic
`ready` → `needs-preparation` → `ready` repair cycle before human escalation.

The human's shaping choice between a draft requirement for coworker review and
a confirmed `needs-preparation` intake, plus later requirement resumption by
uuid, lives in `.agents/protocols/issue-shaping.md`; neither exit grants
`ready`. The shared preparation detail lives in
`.agents/protocols/issue-preparation.md`: the grounded trivial-vs-challenged
classification, challenge questions and recheck. The issue-preparer role owns
the run and its outcome. This spec owns only the final schema and lifecycle
above; do not grow a second copy of either procedure here or in `AGENTS.md`.

## Body sections

Five required `##` headings after the header. The bar for all of them:
**would the implementing agent have to make a product decision the issue
doesn't answer? Then the issue is not `ready`.**

- **What** — one paragraph, the outcome in behavioral terms.
- **Why** — a sentence or two, tied to the spike acceptance criteria or a
  doc. Keeps the agent from "improving" beyond intent.
- **Acceptance criteria** — a short checkbox list (`- [ ]`) of **distinct,
  observable and non-obvious outcomes or invariants**. Each checkbox owns a
  distinct pass/fail outcome; closely coupled conditions may clarify it, but
  do not pack unrelated failures into one checkbox or split to meet a count.
  State what must be true, not how to prove it: unit/e2e scenarios, test files and implementation
  steps belong in Pointers, not in checkboxes. Repository hygiene and delivery
  gates — lint, typecheck, the general test suite, review and CI — already live
  in `AGENTS.md`, `.agents/protocols/delivery-policy.md` and CI; they are never issue acceptance criteria.
  A post-merge corpus update sequenced by `.agents/protocols/delivery-policy.md` is not a diff acceptance
  criterion either; distinguish pre-merge acceptance from verification that
  requires a release, and never report the latter as already passed. Point the
  integrator's post-merge pass to the document under Pointers.
- **Out of scope** — explicit non-goals, or `None.` if genuinely none. This
  is the "least code wins" principle made enforceable: it is what scope
  creep gets rejected against.
- **Pointers** — where a fresh agent should look before writing anything:
  relevant files/modules, prior PRs and issues, relevant neutral procedures, owning corpus
  documents, and known gotchas (e.g. "y-prosemirror deletes unknown elements —
  see #14"). Cite a product doc as `title (uuid)` — e.g. "Editing and blocks
  (b1d5d904-c8b6-46a1-a4df-22251875bcdb)"; `list_docs` against the live
  workspace is the authoritative — and only — source of a uuid. The repository
  holds no copy of the corpus and no uuid table. Cite, never restate: the agent
  reads the doc itself at dispatch, so a pointer that copies its content only
  ages. `None.` only when the grounded change needs no additional pointers;
  explain why no corpus document governs it. Operational policy cannot
  substitute for product context. Every implementing agent starts with zero session memory; this
  section is what makes that cheap instead of expensive.

## Sizing

Prefer substantial independently implementable slices that enable parallel work.
Split when the expected change cannot be reviewed coherently in one sitting or
substantial independent outcomes justify separate work. Different proof
environments, test stages or tiny enabling changes alone do not justify serial
children. Keep cohesive work together and declare real prerequisites; later release
proof alone does not require serial implementation against a settled interface.
Size an investigation's prototype and durable evidence to the uncertainty it
must resolve; a previous spike's report-only PR, separate branch, comparison
matrix or estimates are not automatic deliverables. Needed prototype evidence
must remain reproducible.

A human request may become a parent with several substantial sub-issues. One
`ready` implementation sub-issue describes at most one independently reviewable
PR; each PR closes its sub-issue, and the parent closes after its sub-issues.
Parents live outside the preparation and implementation queues — only their
sub-issues carry `needs-preparation` or `ready` — and the effective-priority
rule above carries the parent's priority to every sub-issue without anyone
writing a label. A program is a milestone plus its parents; nothing dispatches
it but the ordinary queues, and its decisions live on the parent's thread.

The exception runs the other way: individually-trivial issues declaring the
same `Touches` set may be implemented by one agent as one PR closing several
(`Closes #a, #b`), provided the combined diff is still reviewable in one
sitting, the gate check above is applied to that combined diff against the
shared set, and the PR carries the tier-2 merge report of delivery-policy.md's merge
policy, checking each issue's acceptance criteria separately — a batch PR
carries that report even where it would otherwise be tier 1.

### Body focus, and what a body is for

An issue body records the **final contract**, not the history of arriving at
it. Material review corrections, superseded decisions and decision chronology
belong in **comments** — searchable, and out of the way of the person
implementing. Do not copy the original intake verbatim into a new comment after
preparation; preserve its material intent in the final contract and rely on the
issue's edit history for the raw draft. Keep every body as short as complete. A
complex or security-sensitive issue may carry more context when it changes a
decision; a parent carries only the shared outcome and the routing to its
sub-issues. Length alone never decides whether to split.

Preserve the owner's requirements, reasoning, constraints and expressly delegated
engineering choices. Distinguish owner decisions from inferences and cite settled
authority once. Authoring formats and user-visible limitations of durable content
require owner decision; rendering mechanics remain engineering choices within
existing constraints. An inaccessible reference limits evidence, never supplies a
missing product decision. Ask only the unresolved consequence with a recommendation,
keeping independent decisions separate. Before escalating replacement of an
established primitive, identify that primitive and the contract it would supply;
custom application rendering alone does not establish such a replacement. Merge
tier routes approval, not design.

- **Mechanism belongs in a document, not an issue.** When the corpus is
  unreachable and a design lands in an issue body instead, that is a recorded
  debt to repay, not a precedent — see the corpus Editorial contract and AGENTS.md’s authority routing.

Close a parent when its last open sub-issue closes — the integrator whose merge
closes that sub-issue does it in the post-merge pass.

## Lint — the exact checks

An issue labeled `ready` must pass all of:

1. `Touches` line present as the first line, matching the grammar, every name
   valid.
2. `Implements`, where present, occupies one contiguous run of lines directly
   after `Touches`, each matching the grammar above.
3. All five `##` sections present: What, Why, Acceptance criteria,
   Out of scope, Pointers.
4. At least one `- [ ]` checkbox under Acceptance criteria.
5. Out of scope and Pointers are non-empty (explicit `None.` is acceptable).
6. An issue carrying `Implements` has a person's approval of its outcomes, as
   above.

Sizing and decision-completeness are judgment calls, not lintable — the
issue-preparer applies them when granting `ready`, and an implementer given a
`ready` issue failing them returns it.
