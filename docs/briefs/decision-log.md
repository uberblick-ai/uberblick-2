# Brief: decision records and the decision log

Status: **settled direction, 2026-10-03.** Not an issue — the input to the
issues listed under "Build order". It replaces the 2026-08-28 draft and its
review rounds, which remain in git history. Settled in conversation with the
owner on 2026-10-03; the corpus state it starts from was read live that day.

Uberblick is meant for teams. Wherever this brief says a decision is made, it is
made by **a human** — any person with the authority to decide in that
workspace — never by an agent, and never by one named person.

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

## What already exists (and stays)

- A **decision record** is its own document with `kind = decision`, status
  `open` or `decided`, ordinary blocks, and the ordinary comment threads.
- A requirement's **decision log** is the fixed `decisions` root: an ordered
  array of decision uuids, appended when a decision is raised with `governs`.
- A decision may name the decision it replaces with **`supersedes`**, written
  once at creation in the successor's `meta` and never changed. The superseded
  record is never edited; backlinks on it expose its successors.
- The unfiltered `list_docs` omits decisions; any `kind`, `status` or `tag`
  predicate includes them.

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

### 2. Only a human decides

Agents may raise a decision, draft its options and a recommendation, and record
a human's answer. They never decide. A comment or edit by an agent is evidence
until a human adopts it — the rule the agent workflow already states for
product choices, extended to every decision record. No individual is named as
the decider: on a team, whoever holds the authority in that workspace decides.

**Open point — enforcement.** Today an agent can call `set_status decided`
through MCP, and awareness identity is self-asserted, so "a human decided" is a
convention, not a guarantee. Recommendation: MCP keeps setting `decided` only
when recording a human's answer that the record itself cites (who, when, where),
and the hard boundary — `decided` writable only by an authenticated human —
arrives with per-user credentials rather than as a half-trust mechanism now.

### 3. Chains: one topic, several records, bound by `supersedes`

Reconsidering a decided topic creates a **new record** that supersedes the old
one; the old record is never rewritten. A topic's history is the chain of
records linked by `supersedes`. There is no parent or topic object: the chain's
shared title names the topic, and a separate topic document is deferred until
the chain view proves insufficient.

One record per point in time keeps each record short and its reasoning intact.
The alternative — one record accumulating revision paragraphs — is what
*Pipeline ownership for ub launch* became before it was superseded by a short
record; that is the failure this rule avoids.

### 4. In force and pending

For each chain, considering only live (non-archived) decision records:

| Answer | Rule |
| --- | --- |
| **In force** | The newest `decided` record in the chain. This is what agents follow. |
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
- Two live records superseding the same record is a **fork**. It is reported as
  a conflict, never resolved silently by timestamps.
- A superseded record keeps status `decided`; "superseded" is derived from the
  chain, so nobody has to remember to edit the old record.

### 5. Efficient discovery: `supersedes` in the directory stub

The directory stub caches `supersedes` beside `kind` and `status`, under the
same rule as those fields: the document is authoritative, every stub writer
states it rather than carrying it forward, and repair converges the cache.

With that, every answer above comes from the directory alone — one synced
document already in memory, one pass over its stubs, no decision room opened.
A parent-id would cost the same once cached; `supersedes` wins because it needs
no new concept and makes forks visible.

Default behavior:

- `list_docs kind=decision` returns **one row per chain**: the record in force
  if there is one, otherwise the open record, with any pending successor named
  on the row.
- `include_superseded: true` returns every record, history included.
- `get_doc` on a decision returns its predecessors and, when superseded, the
  record that superseded it.
- A requirement's decision log resolves each entry to its chain's current
  answer the same way, and marks entries that are history.

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
references, validated on write and returned by `get_doc`. It is cached in the
stub only if filtering by issue ("which decision covers #1125?") is wanted.
The Editorial contract's ban on issue and PR numbers applies to Regular
Documents; it gains an explicit note that decision `refs` are the exception.

## Re-implementation: no legacy owed

Decision records may be re-implemented from scratch (owner, 2026-10-03). Like
the rest of the pre-launch product, no migration, compatibility window or
legacy detection is owed:

- The `meta.supersedes` key, the stub fields, the `decisions` root's entry
  shape, the MCP arguments (`governs`, `supersedes`) and their refusals may be
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
| Only a human decides | tool descriptions for `set_status` / `create_doc` | Editorial contract, Decision logs guide, agent workflow |
| `supersedes` in the stub, chains, default listing | `packages/schema/src/directory.ts`, stub writers in web and MCP, `list_docs`, `get_doc` | Document model, MCP interface contract |
| `refs` | `packages/schema/src/doc.ts`, MCP create/read | Document model, MCP interface contract, Editorial contract note |

## Build order

Each step is one independently mergeable pull request.

1. Cache `supersedes` in the directory stub; derive in force, pending,
   superseded and forks; make one-row-per-chain the default decision listing,
   with `include_superseded`.
2. Topic and decision wording, optional Reconsidering (gate removed), and the
   "only a human decides" wording, across code descriptions and corpus.
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
- No requirement's decision log holds any entry yet.
