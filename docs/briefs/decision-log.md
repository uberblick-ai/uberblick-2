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
  stays.
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
- **A challenge stops the affected work.** When an agent's work runs against a
  decided record it believes is wrong, it does not work around it: it opens a
  successor stating the challenge, and stops the work that depends on that
  decision until a human answers. Independent work continues.
- No individual is named as the decider: on a team, whoever holds the
  authority in that workspace approves.

Proposed, to confirm: a topic that crosses the agent workflow's boundary table
(product direction and UX, principles and guarantees, resources and
commitments, agent authority) starts `open` even as a first record, because
those choices are a person's from the outset.

### 2a. When to record a decision, and when it is overkill

Record a decision when **all three** hold:

1. **It outlives its task.** The choice still binds something after the issue
   that raised it closes (the boundary the Editorial contract already draws).
2. **Someone could reasonably choose otherwise.** There were real
   alternatives, and a fresh agent or teammate without the reasoning might pick
   a different one.
3. **Choosing otherwise later would be a mistake, not a preference.** The
   quick test: if a fresh agent made the opposite choice next month, would it
   be a bug or a regression someone has to undo?

It is overkill — keep it in the issue, the pull request, or a code comment —
when any of these is true:

- The choice dies with the task: local to one issue or pull request, binding
  nothing after it merges.
- Something already decides it: an existing decision record, a corpus
  document, a linter or formatter, or an established convention in the code.
  Link to that source instead.
- It is cheap to reverse and binds nothing downstream: naming inside one
  module, an internal helper's shape, a test layout.
- It describes current behavior rather than a choice between alternatives.
  That belongs in the Regular Document that owns the behavior; a decision
  records why one option was chosen over another.

When in doubt, an agent records nothing new and mentions the choice in its pull
request; a reviewer or a person can promote it to a decision record later. One
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
- The decider is recorded from the credential's principal, never from a
  self-asserted name.

With the identity in hand, the hub can tell an agent account (today
`uberblick-agent`) from a person's, so agent-decided marking and the rule that
changes need a human can be enforced for agent accounts rather than trusted.
Until device-credential admission ships, both are conventions backed by the
citation in the record.

### 3. All links live on the decision record

Every relationship a decision has is stored on the decision record itself, in
its `meta`, and cached in its directory stub:

| Link | Meaning |
| --- | --- |
| `governs` | The product document (requirement) this decision shapes. |
| `topic` | The topic id shared by every record about the same topic: the uuid of the topic's first record, copied forward when a successor is created. |
| `supersedes` | The record this one replaces, if any. Written once, never changed. |
| `refs` | GitHub issues and pull requests (section 8). |

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

For each topic, considering only live (non-archived) decision records:

| Answer | Rule |
| --- | --- |
| **In force** | The `decided` record that no live `decided` record supersedes — the latest by chain order, never by timestamp. This is what agents follow. |
| **Pending** | An `open` record at the head of the chain, if any: the topic is being reconsidered, or has never been settled. |
| **Superseded** | Every `decided` record that a later live `decided` record supersedes. History only. |

Consequences:

- Opening a reconsideration does not remove the answer in force. While "short
  lease and renew" is open, "long-running" stays in force and is listed with
  *reconsideration open: \<uuid\>*.
- A topic with only an open record has nothing in force and lists as open —
  the "needs a decision" signal of principle 7.
- Abandoning a reconsideration is archiving the open record; the earlier
  decision is in force again with no other state to change.
- Two live `decided` records superseding the same record is a **fork**. The
  topic shows a **conflict** for a person to resolve, listing both records; it
  is never resolved by creation time or any other timestamp. A person resolves
  it by archiving one, or by deciding a new record that supersedes the record
  they keep.
- A superseded record keeps status `decided`; "superseded" is derived from the
  chain, so nobody has to remember to edit the old record.

### 5. Efficient discovery from the directory stub

The directory stub caches `governs`, `topic`, `supersedes` and `refs` beside
`kind` and `status`, under the same rule as those fields: the document is
authoritative, every stub writer states it rather than carrying it forward, and
repair converges the cache.

With that, every answer above comes from the directory alone — one synced
document already in memory, one pass over its stubs, no decision room opened.
`topic` makes grouping one key lookup; `supersedes` orders a chain and exposes
forks.

Default behavior:

- `list_docs kind=decision` returns **one row per topic**: the record in force
  if there is one, otherwise the open record, with any pending successor or
  conflict named on the row.
- `include_superseded: true` returns every record, history included.
- `get_doc` on a decision returns its predecessors and, when superseded, the
  record that superseded it.
- `get_doc` on a requirement returns its derived decision log: one entry per
  topic, oldest topic first, each resolved to its current answer the same way.

### 6. Discussion through the standard comments

Discussion uses the ordinary Yjs comment threads every document has: select the
words in question and comment. No decision-specific comment system, comment
count or status control is added.

### 7. Labels: the existing tag catalog

Decisions carry tags from the workspace catalog like any document, filtered the
same way. No new label field.

### 8. Links to pull requests and issues

A decision may reference the GitHub issues and pull requests that raised or
implement it, through a structured `refs` metadata array of `owner/repo#n`
references, validated on write, returned by `get_doc`, and cached in the stub
so a listing can be filtered by issue ("which decision covers #1125?").
The Editorial contract's ban on issue and PR numbers applies to Regular
Documents; it gains an explicit note that decision `refs` are the exception.

## Re-implementation: no legacy owed

Decision records may be re-implemented from scratch (owner, 2026-10-03). Like
the rest of the pre-launch product, no migration, compatibility window or
legacy detection is owed:

- The requirement's `decisions` root is removed, so a document returns to
  three fixed roots. The `meta` keys, stub fields, MCP arguments (`governs`,
  `supersedes`, and the new `topic` and `refs`) and their refusals may be
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
| Agent initial stance, human-approved changes, agent-decided marker, when to record | `set_status` / `create_doc` (marker, approval of a successor), tool descriptions | Editorial contract, Decision logs guide, agent workflow, role contracts (challenge stops affected work) |
| Links on the record (`governs`, `topic`, `supersedes`) cached in the stub; derived decision log; topics, chains and default listing | `packages/schema/src/doc.ts` (drop the `decisions` root), `packages/schema/src/directory.ts`, stub writers in web and MCP, `create_doc`, `list_docs`, `get_doc` | Document model, MCP interface contract, Decision logs guide |
| `refs` | `packages/schema/src/doc.ts`, stub, MCP create/read | Document model, MCP interface contract, Editorial contract note |

## Build order

Each step is one independently mergeable pull request.

1. Store `governs`, `topic` and `supersedes` on the decision record and cache
   them in the directory stub; drop the `decisions` root; derive the decision
   log (oldest topic first), in force, pending, superseded and conflicts; make
   one-row-per-topic the default decision listing, with `include_superseded`.
2. Topic and decision wording, optional Reconsidering (gate removed), and the
   agent-stance / human-approval rules with the agent-decided marker, and the
   when-to-record test, across code, descriptions, corpus and role contracts.
3. The `refs` field.

The web rendering of the decision log — reading and editing a decision inside
its requirement — stays a separate, later job.

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
