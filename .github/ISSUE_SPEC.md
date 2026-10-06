# Issue spec — ready issues

The contract for issues an implementer may be given. An issue labelled `ready`
that fails any check below is not implementable: the implementer finishes
`returned`, naming exactly what is missing. Bad input is bounced, never
interpreted — no run fills gaps by guessing.

Design principle (same as the repo's data invariants): anything **derivable**
(blocked state, execution order) is computed, never stored; anything **not
derivable** (dependencies, footprint, scope) must be declared, once.

This spec owns the issue's schema, labels and lint. How an issue is shaped,
prepared, split, returned or escalated lives in `.agents/protocols/` and
`.agents/roles/`; do not copy those procedures here.

## Relationships

Dependencies and splits are GitHub issue relationships, not body text:

- **Blocked by** — a real ordering prerequisite: this issue cannot be built
  until that one closes. When ordering depends on an open PR, the issue is
  blocked by the issue that PR closes. If the PR closes no issue, record the
  overlap in Pointers and let the file-overlap rule queue it instead of
  inventing a dependency. Set it with `gh issue create --blocked-by` or
  `gh issue edit --add-blocked-by`.
- **Sub-issue** — the split relation: this issue is one piece of that parent.
  Set it with `gh issue create --parent` or `gh issue edit --parent`. The
  parent is also blocked by each piece, which is true because it closes after
  them, and which lets the priority rule below carry its priority to them.
  Being a sub-issue never affects eligibility. A parent's list of its pieces
  is reading order for a person; the relationships are the authority.

## Machine-readable header

The first lines of the issue body, before any heading:

```
Touches: mcp-server, schema
Implements: <requirement uuid>
```

- **`Touches`** — mandatory. Comma-separated footprint names, lowercase: the
  short names of directories under `packages/` (the live directory listing is
  authoritative), plus `repo` (root config, CI, top-level docs).
  Grammar: `^Touches: [a-z0-9-]+(, [a-z0-9-]+)*$`, every name from that list.
- **`Implements`** — optional, and the only header line that may repeat: one
  line per requirement document, the repeated lines contiguous, directly after
  `Touches`. Grammar:
  `^Implements: <uuid>( \[<block-id>(, <block-id>)*\])?$`, the requirement
  document's uuid and optionally the ids of the outcome blocks this issue
  covers, both read from the live workspace. It is what makes "which issues did
  this requirement become" an `Implements:` search rather than a full-text
  guess, and it is the only line that arms the gate below. A misplaced,
  malformed or non-contiguous line fails the lint rather than being
  interpreted. A requirement cited only under **Pointers** declares and gates
  nothing.

  **`Implements:` narrows who may hold `ready`.** An issue carrying it holds
  `ready` only while a person has approved the outcomes it names, in a comment
  from their own account on the issue or its parent — never `uberblick-agent`
  or a bot. Approval lives in GitHub, never in a document field any client can
  write, so a requirement's `status` authorizes nothing. Whether the approval
  really covers the outcomes named is a judgment for whoever grants `ready`.

### Scheduling semantics

- **Eligible** = labelled `ready` AND not blocked by an open issue. ub-agents
  skips every other issue, and a blocked issue waits at every step: no
  preparation, review or implementation starts on it until its blockers
  close.
- Parallelism is judged at **file** level, not `Touches`-set level: overlapping
  `Touches` sets do not by themselves serialize work, `schema` included. When
  an open pull request is expected to edit the same substantive files
  semantically, the later implementer marks its issue blocked by the issue that
  PR closes and finishes `defer`. A bounded predicted overlap in purely
  additive aggregation surfaces, such as barrel exports or files collecting
  independent error types, is reconciled mechanically: after the earlier merge,
  the later branch synchronizes through a non-rewriting merge only if
  mergeability requires it, and every exact-head gate runs again.
- Order among eligible issues: **effective priority** first — the
  `priority:urgent`, `priority:high`, `priority:medium` and `priority:low`
  labels, an unset label sorting as medium — then oldest first. An issue's
  effective priority is the highest among its own and every open issue it
  blocks, followed transitively, so a prerequisite of urgent work and a
  sub-issue of an urgent parent are both picked as urgent. ub-agents computes
  it from its queue configuration and never writes a label. Who sets priority:
  `.agents/roles/README.md`, Records.

### Gate check

`Touches` is a declared claim, verified at review time: the PR diff must stay
within the declared footprint. A diff that escapes it is a finding — either
the issue was mis-scoped or the agent scope-crept. The resolution is explicit
(fix the scope or re-declare), never silent.

## Request source

`Request Source` is statistical provenance, never a gate: `Human` when the
requested outcome originated with a person, even when an assistant files it,
and `Agent` for an agent-discovered follow-up, finding, audit item or split.
Agents leave it unset; a human may set it in the issue sidebar.

## Labels — lifecycle

| Label | Meaning | Set by |
|---|---|---|
| *(none)* | Draft, or a parent after a split — no role runs on it | — |
| `needs-preparation` | Queued for one issue-preparer pass | A maintainer, or the intake template |
| `needs-review` | Prepared, awaiting its one review | The issue-preparer's `review` outcome |
| `ready` | Spec-complete; an implementer may be given it | A person, the issue-preparer's `ready` outcome, or the reviewer's `approve` |
| `needs-human` | Parked on a question for a person | Any run's `needs-human` outcome |
| `priority:*` | Order among eligible issues (Scheduling semantics) | A person |

Outcomes move these labels, and the pull-request labels, through the table in
`.agents/roles/README.md`. There is deliberately **no `blocked` label**:
blocked is derived from blocked-by relationships plus issue closed-state, and
stored copies of derivable state rot. Nor is there a label for what GitHub's
close reasons already record: not planned, duplicate.

## Body sections

Five required `##` headings after the header. The bar for all of them:
**would the implementing agent have to make a product decision the issue
doesn't answer? Then the issue is not `ready`.**

- **What** — one paragraph, the outcome in behavioral terms.
- **Why** — a sentence or two, tied to the request's acceptance criteria or a
  document. Keeps the agent from "improving" beyond intent.
- **Acceptance criteria** — a short checkbox list (`- [ ]`) of **distinct,
  observable and non-obvious outcomes or invariants**. Each checkbox owns a
  distinct pass/fail outcome; do not pack unrelated failures into one checkbox
  or split to meet a count. State what must be true, not how to prove it: test
  scenarios, test files and implementation steps belong in Pointers. Delivery
  gates (lint, typecheck, tests, review, CI) and the post-merge corpus update
  are never acceptance criteria; distinguish pre-merge acceptance from
  verification that needs a release.
- **Out of scope** — explicit non-goals, or `None.` if genuinely none. This
  is the "least code wins" principle made enforceable: it is what scope
  creep gets rejected against.
- **Pointers** — where a fresh agent should look before writing anything:
  relevant files and modules, prior PRs and issues, relevant procedures,
  owning corpus documents, and known gotchas. Cite a corpus document as
  `title (uuid)`, with the uuid from `list_docs` against the live workspace.
  Cite, never restate: the agent reads the document itself, so a pointer that
  copies its content only ages. `None.` only when the grounded change needs no
  additional pointers; say why no corpus document governs it.

## Sizing

Prefer substantial independently implementable slices that enable parallel work.
Split when the expected change cannot be reviewed coherently in one sitting or
substantial independent outcomes justify separate work. Different proof
environments, test stages or tiny enabling changes alone do not justify serial
children. Keep cohesive work together and declare real prerequisites. Size an
investigation's prototype and evidence to the uncertainty it must resolve;
needed prototype evidence must remain reproducible.

One `ready` implementation sub-issue describes at most one independently
reviewable PR; each PR closes its sub-issue, and the parent closes after its
sub-issues. Parents live outside the preparation and implementation queues, and
the effective-priority rule carries the parent's priority to every sub-issue.
A program is a milestone plus its parents.

The exception runs the other way: individually trivial issues declaring the
same `Touches` set may be implemented as one PR closing several
(`Closes #a, #b`), provided the combined diff is still reviewable in one
sitting, the gate check applies to the combined diff against the shared set,
and the PR carries delivery-policy's tier-2 merge report, checking each issue's
acceptance criteria separately — even where it would otherwise be tier 1.

### What a body is for

An issue body records the **final contract**, not the history of arriving at
it. Review corrections, superseded decisions and chronology belong in
comments. Keep every body as short as complete; a parent carries only the
shared outcome and the routing to its sub-issues. Keep a rule in the issue only
when this change introduces it, changes it, or the code must enforce it;
otherwise link the file that owns it. Distinguish owner decisions from
inferences and cite settled authority once.

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
