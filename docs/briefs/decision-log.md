# Brief: decision records and the decision log

Status: **settled direction, 2026-10-03.** Not an issue — the input to the
issues listed under "Build order". It replaces the 2026-08-28 draft and its
review rounds, which remain in git history. Settled in conversation with the
owner on 2026-10-03; the corpus state it starts from was read live that day.

Uberblick is meant for teams. Agents may take the initial stance on a topic,
but every change to a decision is approved by **a human** — any person with the
authority to decide in that workspace — never by an agent, and never by one
named person.

## The problem

Decisions taken while building are hard to find, and harder still to find in
their current form. A decision that outlives its task belongs in a document
from the moment the topic is raised, not once it is answered; GitHub keeps the
implementation choices that die with one issue. That boundary is already in the
corpus (Editorial contract, Decision logs guide) and does not change here.

What is missing is the shape of a decision over time. A topic such as *lease
renewal in ub-agents* is first decided one way (long-running leases), later
reconsidered, and decided another way (short leases that renew). An agent that
asks for the decisions in force must get one answer per topic — the current one
— and must be able to reach the history only when it asks for it.

## What exists today

- A **decision record** is its own document with `kind = decision`, status
  `open` or `decided`, ordinary blocks, and the ordinary comment threads. This
  stays, with `rejected` added to the status set (section 4a).
- A requirement's **decision log** is a fixed `decisions` root on the
  requirement: an ordered array of decision uuids, appended when a decision is
  raised with `governs`. **This is dropped** (section 3).
- A decision may name the decision it replaces with **`supersedes`**, written
  once at creation in the successor's `meta` and never changed. The superseded
  record is never edited; backlinks on it expose its successors. This stays.
- The unfiltered `list_docs` omits decisions; any `kind`, `status` or `tag`
  predicate includes them. This stays.

## The settled design

### 1. A decision is a topic and a decision

A record is about a **topic**. The topic may be phrased as a question, but it
does not have to be: "Lease renewal in ub-agents" is as good a title as "How
should ub-agents renew leases?". While open, the body states the topic and the
context needed to decide it, with options where they help. Once decided, the
body leads with **the decision itself**, then the reasoning and the guidance it
gives the work that follows.

**A record stays short; details live in GitHub** (owner, 2026-10-03). A
decision record carries the topic, the decision, the reasons that still bind,
and the guidance for later work — a few short paragraphs, readable in a
minute. Evidence, investigation, measurements, the full weighing of
alternatives and implementation notes belong in the issue or pull request the
record links to (section 8). A reader who needs the depth follows
the link; a record that grows past a screen has GitHub material in it.

A "Reconsidering" section is **optional**. Write one when a real revival
trigger is known; do not invent one to satisfy a gate. The `set_status` /
`create_doc` refusal that requires an exact `Reconsidering` heading before
`decided` is removed.

### 2. Agents take the initial stance; humans approve changes

Settled 2026-10-03:

- **Agents may create a record and take the initial stance.** When an agent
  meets something that should be recorded (section 2a), it creates the topic's
  first record and may record its stance as `decided`, with its reasoning. The
  record is marked as **agent-decided**, and agent-decided records are listed
  for people to review (principle 7). A human confirms one by approving it,
  which clears the marker, or changes it through a superseding record.
- **Every change needs human approval.** Superseding a decided record — any
  change to the answer in force — takes effect only when a human approves it.
  An agent may open the successor and argue for it; it stays `open` until a
  person answers. Approval may be given in the web or through MCP, where the
  agent records the human's answer and the record cites it (who, when, where).
- **A decided record is read-only** (owner, 2026-10-03). Once a record is
  `decided`, every write surface — MCP block and metadata tools and the web
  editor — refuses changes to its text and decision line; comments stay open.
  Any change, a wording fix included, goes through Reconsider as a new record
  a person approves. Recording a person's answer stores an **approval
  fingerprint** of the content they approved: the title, the decision line and
  the block text. It excludes comments, comment anchors and the approval
  bookkeeping itself, so discussion never invalidates an approval (the
  existing document fingerprint hashes annotations and cannot be reused). Because a
  read-only rule is enforced per replica, an edit made offline before the
  decision can still merge afterwards; when the content's fingerprint no
  longer matches the approved one, the record shows *changed after approval*
  and lists as needing a person, who either re-approves it or reconsiders.
- **A challenge stops the affected work.** When an agent's work runs against a
  decided record it believes is wrong, it does not work around it: it opens a
  successor stating the challenge, and stops the work that depends on that
  decision until a human answers. Independent work continues.
- No individual is named as the decider: on a team, whoever holds the
  authority in that workspace approves.

- **Boundary topics start open** (owner, 2026-10-03). A topic that crosses the
  agent workflow's boundary table (product direction and UX, principles and
  guarantees, resources and commitments, agent authority) starts `open` even as
  a first record, with the agent's recommendation, because those choices are a
  person's.
- **Open does not mean blocked** (owner, 2026-10-03). Work proceeds on the
  open record's recommended option, and merging continues. The issue or pull
  request says *built on open decision: \<topic\>, recommended option*, so a
  reversal can find what was built on it. Hardly anything is irreversible, so
  the line is **major impact**: only work that would be expensive to reverse
  waits for a human answer — for example swapping a core technology
  (PostgreSQL for MongoDB), changing a data format users or other systems
  depend on, or making users migrate. Releases, data migrations and permission
  changes are not automatically on that list. If a person decides differently, the new
  decision supersedes the recommendation and a follow-up issue does the
  rework; that rework cost is accepted to avoid slowing delivery. The agent
  workflow's "at a boundary, pause only affected work" narrows to those
  major-impact steps, and that document changes with it. This concerns only
  work *within an already approved issue* whose implementation meets an open
  decision. It approves no new outcome: `ISSUE_SPEC.md`'s person-approval rule
  for `Implements:` outcomes, its refusal of unresolved product choices in a
  ready issue, and `delivery-policy.md`'s review and merge tiers all stay as
  they are.
- **Opening a topic and challenging a decision differ.** A new open topic
  proceeds on its recommendation; a challenge to a `decided` record stops the
  work that depends on it, as above.

### 2a. When to record a decision, and when it is overkill

Record a decision when **all three** hold:

1. **It outlives its task.** The choice still binds something after the issue
   that raised it closes (the boundary the Editorial contract already draws).
2. **There was a real alternative** not already dictated by an existing
   decision record or corpus document.
3. **Reversing it costs something:** it fixes user-facing behavior, a command
   or API, a data shape, a guarantee, a dependency, or a process rule. Quick
   test: if a fresh agent made the opposite choice next month, would someone
   have to undo it?

It is overkill — keep it in the issue, the pull request, or a code comment —
when any of these is true:

- The choice dies with the task: local to one issue or pull request, binding
  nothing after it merges.
- Something already decides it: an existing decision record, a corpus
  document, a linter or formatter, or an established convention in the code.
  Link to that source instead.
- It is cheap to reverse and binds nothing downstream: naming, refactors, an
  internal helper's shape, test structure.
- It is a bug fix that restores intended behavior.
- It describes current behavior rather than a choice between alternatives.
  That belongs in the Regular Document that owns the behavior; a decision
  records why one option was chosen over another.

When in doubt, an agent records nothing new and mentions the choice in its pull
request; a reviewer or a person can promote it to a decision record later.

**Reviewers flag; implementers write** (owner, 2026-10-03). When a pull
request settles something that passes this test without a record, the reviewer
raises it as a finding instead of drafting the record. The implementer, who
holds the reasoning, writes the record in the same pull request — an initial
stance, or `open` on a boundary topic — and the reviewer verifies it like any
other correction. The pull request is not held for a person's confirmation. One
topic per record: a record that collects many choices (*Deferred designs and
their triggers*) is a catalog, not a decision.

**Identity comes with GitHub sign-in.** The hub's GitHub device flow already
identifies a durable GitHub account (a hub principal) and issues one device
credential for that account's existing workspace memberships; the live hub and
`ub open` do not yet admit with it, so MCP still uses the shared secret. Once
admission switches to device credentials, every MCP process on a device carries
the identity of whoever signed that device in — agents on a person's machine
act under that person's GitHub identity. Two consequences:

- The identity says *whose credential* recorded the decision, not whether a
  person or an agent made the call. On a person's device, "changes need a
  human" stays a rule agents obey; the hub cannot tell the two apart there.
- A record stores two people separately: **who decided** (the person whose
  answer is recorded) and **who recorded it** (the principal of the
  connection that wrote it). They differ whenever an agent records a person's
  answer through MCP.
- Admission identifies the connecting principal, not the author of every Yjs
  update it relays: a replica can forward another participant's or an offline
  edit. So identity lets the hub refuse a `decided` write that arrives on a
  connection authenticated as an agent account, but it cannot prove who
  approved. Verifiable approval provenance needs its own design and is out of
  scope here.

Until such a design exists, "changes need a person" is a convention backed by
the recorded answer and its citation, with one cheap guard once
device-credential admission ships. From an agent-account connection (today
`uberblick-agent`), `decided` is accepted only as a topic's first record carrying
the agent-stance marker, or when it records a person's answer. Clearing the
marker or deciding a successor without a recorded answer is refused.

### 3. All links live on the decision record

Every relationship a decision has is stored on the decision record itself, in
its `meta`, and cached in its directory stub:

| Link | Meaning |
| --- | --- |
| `governs` | The product document (requirement) this decision shapes. |
| `topic` | The topic id shared by every record about the same topic: the uuid of the topic's first record, copied forward when a successor is created. |
| `supersedes` | The record this one replaces, if any. Written once, never changed. |

The per-requirement `decisions` array is dropped. A product document's decision
log is **derived**: the decisions whose stub `governs` it, grouped by `topic`.
Nothing on the requirement has to be written when a decision is raised,
reconsidered or archived, so the requirement and its decisions can never
disagree about membership.

**Order of the log is topic age, oldest first** (owner, 2026-10-03): topics are
listed by the creation time of their first record. Reconsidering a topic keeps
its place. This default holds until a requirement asks for another order.

### Chains: one topic, several records

Reconsidering a decided topic creates a **new record** that supersedes the old
one and carries the same `topic`; the old record is never rewritten. A topic's
history is its chain of records, linked by `supersedes` and grouped by `topic`.
The topic needs no document of its own: the chain's shared title names it.

One record per point in time keeps each record short and its reasoning intact.
The alternative — one record accumulating revision paragraphs — is what
*Pipeline ownership for ub launch* became before it was superseded by a short
record; that is the failure this rule avoids.

### 4. In force and pending

For each topic, considering every record except `rejected` and `withdrawn` ones — individual archive state is never consulted:

| Answer | Rule |
| --- | --- |
| **In force** | The single `decided` record that no live `decided` record supersedes, directly or through intermediate records — never chosen by timestamp. This is what agents follow. |
| **In conflict** | Two or more such maximal `decided` records. None is in force; all are listed and the topic shows a conflict. |
| **Pending** | Every live `open` record in the topic — there may be several, for instance two agents reconsidering offline at once. |
| **Superseded** | Every `decided` record that a live `decided` record supersedes, directly or transitively. History only. |

Resolution runs over the topic's whole `supersedes` graph, not a single
chain. Example: with B → A, C → A and D → B, all decided, the maximal decided
records are C and D — a conflict. Rejecting B changes nothing (D still
descends from A); a person resolves it by rejecting C or D.

Consequences:

- Opening a reconsideration does not remove the answer in force. While "short
  lease and renew" is open, "long-running" stays in force and is listed with
  *reconsideration open: \<uuid\>*.
- A topic with only an open record has nothing in force and lists as open —
  the "needs a decision" signal of principle 7.
- A person declining a reconsideration sets it `rejected`; the earlier
  decision stays in force. Its author dropping it before anyone answers sets
  it `withdrawn`. Neither is archived: both stay in the history.
- More than one maximal `decided` record is a **conflict** for a person to
  resolve; it is never resolved by creation time or any other timestamp. A
  person resolves it by rejecting maximal records until one remains.
- A superseded record keeps status `decided`; "superseded" is derived from the
  chain, so nobody has to remember to edit the old record.

### 4a. Every record in a topic's history ends with an outcome

A topic's history is a list of its records, **newest first** (owner,
2026-10-03) — by chain order where one record supersedes another, by creation
time for records outside the chain such as rejected proposals — and each one ends in
exactly one outcome a reader can see without opening it:

| Outcome | Meaning | Source |
| --- | --- | --- |
| **In force** | The current answer. | Derived (section 4) |
| **Superseded** | Was in force; replaced by the named later record. | Derived from `supersedes` |
| **Rejected** | Proposed — a first stance, a reconsideration or one side of a conflict — and a person declined it. | Status `rejected` |
| **Withdrawn** | Proposed and dropped by its author before anyone answered. | Status `withdrawn` |
| **In conflict** | One of several competing decided records; waits for a person to keep one. | Derived (section 4) |
| **Open** | Proposed and waiting for a person. | Status `open` |

Every record — current or historical — is its own document, its own Y.Doc
with its own blocks and comment threads (owner, 2026-10-03); history is never
folded into one record. Each row shows that record's **comment count**, so a
reader sees where the discussion happened before opening anything.

Each row also says who decided or approved it, and when; a confirmed agent
stance reads *confirmed by \<person\>*. There is no summary such as "changed
twice": the outcomes are the summary. A decision record's status set therefore
becomes `open | decided | rejected | withdrawn`; `rejected` and `withdrawn`
records count for neither in force nor pending, and stay readable in the
history for their reasoning.

**History is immutable; only a whole topic is archived** (owner, 2026-10-03).
No individual decision record is ever archived, restored or deleted, so
nothing can silently bring an earlier answer back into force. Archiving
applies to a whole topic that no longer matters: `archive_doc` on any record of
a topic archives every record in it, and `restore_doc` restores them all,
reported per room in the existing partial-write shape. The topic's archive
state has one authority: the tombstone of its **first record**, whose uuid is
the `topic` id. Every other record's own tombstone only mirrors it and is
never read for authority. Resolution (section 4) always runs over every
record in the topic regardless of individual tombstones, so a partial or
concurrent archive or restore can change only whether the whole topic is
visible, never which answer is in force. Concurrent archive and restore of
the first record converge like any directory tombstone today. An archived topic
leaves listings and its product document's decision log, and its records stay
readable by uuid and fully read-only. Retiring a decision while keeping the
topic is a superseding record that says so (for example *Lease renewal: no
longer applies*), approved by a person.

**Reading an earlier record.** Every history row opens that record in the same
decision view as the current one, read-only. It must be unmistakable that this
is an older version, not the answer to follow: a persistent banner at the top
names its outcome (*Superseded*, *Rejected*, *Withdrawn*) and its successor
when it has one, and the view is visibly muted against the current record's, so nobody mistakes
it for the live answer. The banner carries one prominent action, **Go to the
current decision**, which opens the record in force — or, when nothing is in
force, the record currently being decided — in one tap, without returning to
the history list. When the topic has neither a record in force nor one being
decided — a rejected or withdrawn first proposal — the banner says so and the
action is omitted. A superseded or rejected record is never edited, so the
view offers no editing; comments stay possible on it, so someone can ask about
old reasoning where it was written. Only an archived topic is fully
read-only, comments included. Because
a record stays short (section 1), reading an old one shows the reasoning at a
glance, and its links lead to the issue or pull request that holds the
detail.

### 5. Efficient discovery from the directory stub

The directory stub caches, beside `kind` and `status`, everything the
listings and history rows show:

| Cached field | Source in the document | Shown as |
| --- | --- | --- |
| `governs`, `topic`, `supersedes` | `meta` links (section 3) | Grouping, chain order, conflicts |
| `tldr` | `meta.tldr` — the decision line (section 1) | The answer on every log and history row |
| `agentStance` | `meta`, set when an agent records a stance, cleared on confirmation | *Agent stance* state |
| `decidedBy`, `decidedAt` | `meta`, written when a person's answer is recorded | "Decided by … on …", "confirmed by …" |
| `commentCount` | Comments across the record's threads | The comment count |

The document is authoritative. Writers that hold the hydrated document —
creation, edits, status changes, and stub repair — restate every field from it.
Directory-only writers that never hydrate the document — `archive_doc`,
`restore_doc` and the schema's tombstone and restore operations — preserve the
cached fields as they find them, so an archive never erases a relationship.
Comparison, serialization, tombstone and restore paths gain the new fields
together. The decision line moving into the stub replaces the Document
model's current rule that the TL;DR has no stub (allowed: section
"Re-implementation").

With that, every answer above comes from the directory alone — one synced
document already in memory, one pass over its stubs, no decision room opened.
`topic` makes grouping one key lookup; `supersedes` orders a chain and exposes
forks. `commentCount` lets a history list show counts without opening a
room; like `updatedAt` it is a display hint, recomputed from the document's
threads by whichever writer changes them and healed by stub repair.

Default behavior:

- `list_docs kind=decision` returns **one row per topic**: the record in force
  if there is one, otherwise the open record, with any pending successor or
  conflict named on the row.
- `include_superseded: true` returns every record, history included.
- Filters select **topics**, and resolution always uses the topic's whole
  unfiltered graph. A `status` or `tag` predicate matches a topic when any of
  its live records matches; the row still shows the topic's resolved answer.
  With `include_superseded`, predicates apply to individual records instead.
  `include_deleted` adds archived topics; archiving never changes what is in
  force within a topic, because records are never archived one by one.
- `get_doc` on a decision returns its predecessors and, when superseded, the
  record that superseded it.
- `get_doc` on a requirement returns its derived decision log: one entry per
  topic, oldest topic first, each resolved to its current answer the same way.

### 6. Discussion through the standard comments

Discussion uses the ordinary Yjs comment threads every document has: select the
words in question and comment. No decision-specific comment system is added:
counts come from the ordinary threads, and the only decision-specific controls
are the lifecycle actions (confirm, approve, reject, reconsider) described
above.

### 7. Labels: the existing tag catalog

Decisions carry tags from the workspace catalog like any document, filtered the
same way. No new label field.

### 8. Links to pull requests and issues

**Plain links in the document, GitHub references derived** (owner,
2026-10-03). A record links the issues and pull requests that raised or
implement it as ordinary links in its text — by convention a short *Links*
list at the end of the page — with no separate metadata field. When the
derived index processes a record, it extracts every link that points to a
GitHub issue or pull request and stores it beside the record, so "which
decision covers #1125?" is a cheap lookup like search. The text stays the one
source; nothing is written twice or kept in sync.

The reverse direction needs no field either. Work built on an open decision
says so in its issue or pull request (*built on open decision: \<topic\>,
\<topic uuid\>*), **and** the implementer adds that issue or pull request,
repository-qualified (`owner/repo#n`), to the open record's *Links*. The
decision record therefore carries its own rework list, and the derived lookup
finds it without reading GitHub.

The Editorial contract's ban on issue and PR numbers applies to Regular
Documents; it gains an explicit note that decision records may link them.

## Design work

The web surface is designed before it is built, as its own step after the data
model (build step 4). The 2026-08-28 mockup (`assets/decision-log-mockup.png`)
is superseded: its three-state control, comment count and inline rows predate
topics, chains, agent stances and conflicts.

### Surfaces to design

| Surface | What it must show |
| --- | --- |
| Decision log on a product document | A fixed section after the body, one row per topic, oldest topic first. Each row: topic title, current answer, and a state — Open, Decided, Decided by agent, Reconsideration open, Conflict. |
| Decision view | One decision record read, edited and commented in context, over the still-visible product document. |
| Reconsider | Starting a reconsideration turns the open decision view into the new draft record in place — never a dialog on top of a dialog. The draft is one ordinary document, seeded with a short outline (proposed decision, why, options) the author may rewrite or delete; no form fields. The record being reconsidered stays visible beside it. |
| Approve and change | Confirming an agent-decided record, approving or rejecting a reconsideration, and resolving a conflict — the only human-gated actions, so they must be obvious and hard to trigger by accident. |
| History | A topic's records newest first, each ending in its outcome (section 4a) with who, when and its comment count; every row clickable into a read-only, visibly older view of that record with a banner naming its outcome and a one-tap **Go to the current decision** (in force, or being decided). |
| Open decisions (later) | One list, titled **Open decisions**, across the workspace of open topics, agent-decided records awaiting review, and conflicts (principle 7) — where a person answers many small decisions quickly. Built last, once everything else works; until then the sidebar's Decisions section has only **All records** (owner, 2026-10-03). |
| Decisions in the document list | The existing *Decisions* mode in `shell/DocumentList.tsx`, showing one row per topic by default. |
| Built-on marker | How an issue or pull request built on an open decision is visible from the decision, so a reversal finds its rework. |

### Constraints

- One layer: the decision view is the only dialog; every step inside it (reading history, drafting a reconsideration) replaces its content rather than stacking another dialog (owner, 2026-10-03).
- A record's text is one Yjs document with ordinary blocks, never split into form fields (owner, 2026-10-03).

- Off-the-shelf first: shadcn/ui components on Tailwind, reusing what the web
  already ships (`ui/shadcn/dialog.tsx`, `sheet.tsx`, `popover.tsx`,
  `LifecycleBadge`, the Threads rail and comment composer).
  Custom components need a reason the standard one cannot meet.
- iPhone, iPad and a 13-inch MacBook, with touch as a first-class input; the
  phone and iPad layouts are designed, not left to shrink.
- Discussion is the standard comment threads (section 6); no decision-specific
  conversation UI.

### Starting point and open design questions

Spike #844 (`docs/spikes/844-decision-in-context.md`) recommends a modal over
the still-mounted requirement for the decision view, using the existing dialog
and a second `EditorPane`. Its open choices become the design questions:

1. Does an open decision view have its own address, so reload, Back and a
   shared link restore it?
2. Where does the decision's comment rail live while the modal is open — its
   own rail, or the shell's rail swapped to the active document?
3. Which editor chrome belongs in the compact view, and how much of the
   product document stays visible behind it?
4. On a phone, is the decision view a full-height sheet rather than a modal?
5. How do archive, supersession or a conflict arriving while the view is open
   close it or turn it read-only?

### Design deliverable

A clickable design covering every surface above in each state (Open, Decided,
Decided by agent, Reconsideration open, Conflict, archived), at phone, iPad and
laptop widths, with the approve and change flows walked through. A person
reviews it before the web issues are written; the spike's prototype branch
remains available as an integration reference.

## Where agent behavior lives

Every agent rule in this brief — taking an initial stance, raising a
reconsideration, stopping work on a challenge, marking work *built on open
decision*, reviewers flagging missing records, the when-to-record test — is written
into **uberblick-2's own instruction files**, never into ub-agents (owner,
2026-10-03). ub-agents runs roles and applies the label changes a project
declares; it knows nothing about Uberblick, decision records or this corpus,
and needs no change for any of this. The lease-renewal topic used throughout
is sample content only.

| Rule | Instruction file in uberblick-2 |
| --- | --- |
| When to record; initial stance; boundary topics start open | `.agents/protocols/delivery-policy.md`, `.agents/roles/implementer.md` |
| Proceed on an open decision's recommendation; *built on open decision* line; major-impact steps wait | `.agents/roles/implementer.md`, `.github/ISSUE_SPEC.md` |
| A challenge stops the dependent work | `.agents/roles/implementer.md`, `.agents/roles/issue-preparer.md` |
| Reviewers flag missing records; implementers write them | `.agents/roles/reviewer.md`, `.agents/protocols/review-protocol.md`, `.agents/roles/implementer.md` |
| Preparers cite relevant decisions in the reading guide | `.agents/protocols/issue-preparation.md` |
| Shaping raises decisions as records rather than issue text | `.agents/protocols/issue-shaping.md` |

## Re-implementation: no legacy owed

Decision records may be re-implemented from scratch (owner, 2026-10-03). Like
the rest of the pre-launch product, no migration, compatibility window or
legacy detection is owed:

- The requirement's `decisions` root is removed, so a document returns to
  three fixed roots. The `meta` keys, stub fields, MCP arguments (`governs`,
  `supersedes`, and the new `topic`) and their refusals may be
  redefined wherever a cleaner shape is simpler; nothing must keep reading the
  old one.
- The `Reconsidering` gate is deleted outright, not deprecated.
- The six existing decision records are re-created or re-stated by hand under
  the new shape, with chains set where one record replaces another (*Keep the
  coding-agent runner in the separate ub-agents tool* supersedes *Pipeline
  ownership for ub launch*). A record that is not one decision — *Deferred
  designs and their triggers* is a catalog of many — is split or becomes an
  ordinary document.
- An implementation may therefore take the build order below in fewer steps
  when that is simpler, as long as each pull request stays reviewable in one
  sitting.

## What changes, and where

| Change | Code | Corpus and instructions |
| --- | --- | --- |
| Topic wording | — | Editorial contract (Decision template), Decision logs guide |
| Optional Reconsidering | `packages/mcp-server/src/tools.ts` (`hasRevivalTrigger` and both callers, tool descriptions), `failures.ts`, tests in `test/descriptions.test.ts`, `test/archive.test.ts` | Editorial contract, MCP interface contract, `.agents/protocols/issue-shaping.md` |
| Agent initial stance, human-approved changes, agent-decided marker, when to record | `set_status` / `create_doc` (marker, approval of a successor), tool descriptions | Editorial contract, Decision logs guide, agent workflow, uberblick-2 `.agents/` roles and protocols |
| Links on the record (`governs`, `topic`, `supersedes`) cached in the stub; derived decision log; topics, chains and default listing | `packages/schema/src/doc.ts` (drop the `decisions` root), `packages/schema/src/directory.ts`, stub writers in web and MCP, `create_doc`, `list_docs`, `get_doc` | Document model, MCP interface contract, Decision logs guide |
| GitHub links derived from record text | derived index in `packages/mcp-server` (extract GitHub issue/PR links from link marks), a lookup by issue or PR | MCP interface contract, Editorial contract note |

## Build order

Each step is one independently mergeable pull request.

1. Store `governs`, `topic` and `supersedes` on the decision record and cache
   them in the directory stub; drop the `decisions` root; derive the decision
   log (oldest topic first), in force, pending, superseded and conflicts; make
   one-row-per-topic the default decision listing, with `include_superseded`.
2. Topic and decision wording, optional Reconsidering (gate removed), and the
   agent-stance / human-approval rules with the agent-decided marker, and the
   when-to-record test, across code, descriptions, corpus and uberblick-2's
   `.agents/` instruction files (section "Where agent behavior lives").
3. The derived index of GitHub links in decision records, with a lookup by
   issue or pull request.

4. Design the web surface (section "Design work"), reviewed by a person.
5. Build the web surface from the reviewed design, split into issues by
   surface.

## Corpus findings to reconcile alongside

Read live on 2026-10-03; none of these is fixed by this brief.

- *Product and collaboration principles* says all seven were adopted on
  2026-09-03 but its status is still `open`.
- *Local-first per identity* describes itself as an open decision but carries no
  kind, so the decision filter misses it.
- Four of the six decision records lack a Reconsidering section; with the gate
  removed that is no longer a defect.
- No requirement's decision log holds any entry yet, so dropping the
  `decisions` root loses nothing.
