# Issue spec — ready issues

The content contract for a `ready` issue. An implementer returns a contract that
fails it, naming the missing requirement under the
[return handoff](../.agents/roles/implementer.md#outcomes); never fill gaps by guessing.

[Preparation](../.agents/protocols/issue-preparation.md) owns clarification,
review and resumption. Consult [workflow](../.agents/protocols/workflow.md) for
scheduling or lifecycle diagnosis, and [run operations](../.agents/protocols/run-operations.md#request-source)
for issue-creation metadata. They are not additional routine preparation reads.

Design principle (same as the repo's data invariants): anything **derivable**
(blocked state, execution order) is computed, never stored; anything **not
derivable** (dependencies, footprint, scope) must be declared, once.

## Relationships

Dependencies and splits are GitHub issue relationships, not body text:

- **Blocked by** — a real ordering prerequisite: this issue cannot be built
  until that one closes. An open PR that only edits the same files is not
  one: record it in Pointers and build alongside it. Set it with
  `gh issue create --blocked-by` or `gh issue edit --add-blocked-by`.
- **Sub-issue** — the split relation: this issue is one piece of that parent.
  Set it with `gh issue create --parent` or `gh issue edit --parent`. The
  parent is also blocked by each piece, so priority inherits and the parent
  closes after its children. Being a sub-issue never affects eligibility.
  Relationships, not a parent's prose list, are authoritative.

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
  table. It supports exact requirement-to-issue retrieval and alone activates
  the approval gate below. A misplaced, malformed or
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

### Gate check

`Touches` is a declared claim, verified at review time: the PR diff must stay
within the declared footprint. A diff that escapes it is a finding — either
the issue was mis-scoped or the agent scope-crept. The resolution is explicit
(fix the scope or re-declare), never silent.

## Body sections

Five required `##` headings after the header. The bar for all of them:
**would the implementing agent have to make a product decision the issue
doesn't answer? Then the issue is not `ready`.**

Implementation within an already approved outcome may
[build on an open decision](../.agents/roles/implementer.md#build-on-an-open-decision).
That exception supplies no new approved outcome or `Implements:` approval and
waives neither this ready bar nor review and merge gates.

- **What** — one paragraph, the outcome in behavioral terms.
- **Why** — explain the problem or value in a sentence or two, citing
  supporting evidence where useful.
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
- **Out of scope** — explicit non-goals, or `None.` if genuinely none; the
  boundary used to reject scope creep.
- **Pointers** — where a fresh agent should look before writing anything:
  relevant files/modules, prior PRs and issues, relevant neutral procedures, owning corpus
  documents, and known gotchas (e.g. "y-prosemirror deletes unknown elements —
  see #14"). Cite a product doc as `title (uuid)`, using its discovered title and
  UUID from live `list_docs` discovery; the repository holds no corpus copy or
  UUID table. Cite rather than copy content; the agent reads the live source.
  When the change touches a user-facing surface (a `ub` command, an MCP tool, a
  web UI flow), cite the page that owns it, even when the issue did not start
  from that page.
  `None.` only when the grounded change needs no additional pointers;
  explain why no corpus document governs it. Operational policy cannot
  substitute for product context. Supply enough pointers for a fresh session.

### Body focus, and what a body is for

An issue body records the **final contract**, not the history of arriving at
it. Material review corrections, superseded decisions and decision chronology
belong in **comments** — searchable, and out of the way of the person
implementing. Do not copy the original intake verbatim into a new comment after
preparation; preserve its material intent in the final contract and rely on the
issue's edit history for the raw draft. Keep every body as short as complete. A
complex or security-sensitive issue may carry more context when it changes a
decision; a parent carries only the shared outcome and the routing to its
sub-issues. Length alone never decides whether to split. Keep a rule in the
issue only when this change introduces it, changes it, or the code must
enforce it; link to the role file, protocol or guide that already owns it
otherwise.

Cut repeated explanation first and keep acceptance criteria concise under the
rules above. Put necessary extended supporting evidence in clearly labelled
`<details>` blocks under Pointers, with a brief visible summary. Keep the outcome,
scope, acceptance criteria, essential constraints and unresolved decisions visible;
never hide requirements in collapsed content.

Preserve authorized outcomes, the maintainer's reasoning and constraints, essential
guarantees and delegated engineering choices; do not add convenient extras.
Use evidence for factual gaps and make engineering choices within scope, never
inventing product intent. Apply [settled authority](../AGENTS.md#find-the-right-authority)
and escalate only [unresolved maintainer choices](../.agents/protocols/human-decisions.md).
Missing references grant no permission; merge tiers grant no additional design authority.

- **Mechanism belongs in a document, not an issue.** When the corpus is
  unreachable and a design lands in an issue body instead, that is a recorded
  debt to repay, not a precedent — follow AGENTS.md's authority routing and
  corpus-edit rules, plus governing authoring guidance discovered in the live corpus.

## Sizing

Prefer substantial independently implementable slices that enable parallel work.
Split when the expected change cannot be reviewed coherently in one sitting or
substantial independent outcomes justify separate work. Different proof
environments, test stages or tiny enabling changes alone do not justify serial
children. Keep cohesive work together and declare real prerequisites; later release
proof alone does not require serial implementation against a settled interface.
Size an investigation's prototype and durable evidence to the uncertainty it
must resolve, without inheriting deliverables from earlier investigations.
Needed evidence must remain reproducible.

Each implementation sub-issue describes at most one independently reviewable PR,
which closes that child. A parent carries the shared outcome and child routing;
its lifecycle belongs to [workflow](../.agents/protocols/workflow.md#parents-and-programs).

Individually-trivial issues declaring the same `Touches` set may be implemented
by one agent as one PR closing several (`Closes #a, #b`), provided the combined
diff is reviewable in one sitting and passes the gate check against that shared
footprint. The [batch merge report](../.agents/protocols/delivery-policy.md#batch-merge-reports)
is mandatory.

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

Sizing and decision-completeness are judgment calls, not lintable. The
issue-preparer assesses and reports readiness; ub-agents applies workflow labels.
An implementer given a `ready` issue failing these checks returns it.
