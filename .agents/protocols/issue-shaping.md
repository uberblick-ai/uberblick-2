# Issue shaping — conversation to requirement or intake

This protocol owns the conversation that turns a behavioral request into a
confirmed requirement document or GitHub intake. Use it when a human wants to
explore or shape new functionality, even before they ask for an issue.
Discussion may end with a clearer direction or an unresolved question; issue
creation is not required.
After the meaning is confirmed, the human chooses whether to publish it as a
draft requirement for coworker review or create an issue with
`needs-preparation`. Neither path prepares an issue, decides that it is
`ready`, or replaces `.github/ISSUE_SPEC.md`.

## Start with discovery, not a draft

Do not respond to a behavioral request by immediately writing an issue,
acceptance criteria, implementation plan, or proposed architecture. First
understand the request in the user's terms. Treat a suggested mechanism as
evidence about the desired outcome, not as a requirement, unless the human
explicitly confirms that the mechanism itself is binding.

Ask one focused question at a time only when its answer could materially change
the intake. Skip anything the user already answered or that repository
grounding can derive later. Do not turn the conversation into a fixed
questionnaire.

Discover, in proportion to the request:

- the problem or present behavior;
- who is affected, when that matters;
- the intended outcome;
- what observation or example would show success;
- the decision principles behind the request;
- acceptable trade-offs;
- behavior that must not change;
- meaningful scope boundaries; and
- unresolved choices that only a human can make.

Repository facts, likely files, dependencies, implementation options, and edge
cases may help formulate a question. They are agent inferences until a human
adopts them. Say which is which: use language such as "You said…" for a human
statement and "I infer…" or "A possible implication is…" for an inference.

## Keep the effort oriented

For a substantial discussion, establish the intended outcome in one or two
sentences and use it to choose which questions matter next. Keep a compact
working overview of settled decisions, open questions, detail not yet clear
enough to specify, and work outside this effort. Ordinary small requests need
no overview. Refresh it when decisions change or the conversation resumes,
not after every message. Refer to issues by descriptive linked titles in prose;
retain the identifiers required by machine-readable records.

Separate an empirical uncertainty from a human choice and an ordinary
engineering judgment. Read available evidence to answer factual questions;
ask the human about unresolved intent or trade-offs; leave routine technical
choices to preparation and implementation. Do not reopen a settled human
choice without new conflicting evidence or changed direction. Name the
conflict when one exists.

Before proposing an investigation, identify the decision it would inform, the
uncertain assumption, and an observation that could support or overturn it.
Prefer the cheapest useful evidence before elaborating dependent designs.
A bounded negative result can be useful. Use read-only exploration during
shaping; follow existing authorization and repository rules for experiments.
Do not turn every question into a spike, or require the eventual feature to
work for an investigation to succeed.

Specify only work whose purpose is clear. Keep unclear future detail in the
overview instead of inventing implementation slices or decision tickets.
Deferred detail remains distinct from work outside the intended outcome;
neither is automatically a new issue. Multiple decisions may be resolved in
one conversation.

For continuity across sessions, offer to preserve the overview on an existing
relevant effort issue. Once the human authorizes that write, record a concise
comment linking authoritative decisions and relevant issues rather than copying
their contracts. On resumption, read that context and subsequent decisions;
an overview is an index, not a competing authority. This permission to record
context does not grant queue transitions, dependency edits, a new umbrella, or
new decision tickets. If no effort issue exists, retain the overview in the
conversation until a confirmed intake is appropriate.

## Reflect meaning before writing

When the material meaning is clear, reflect it back compactly for correction:

- the problem and intended outcome;
- the success evidence or example;
- the decision principles, trade-offs, and must-not-change behavior that
  constrain it;
- the proposed scope boundary; and
- any unresolved human choice, explicitly marked unresolved.

Ask the user to correct the meaning. Do not treat silence, a topic change, or a
request for more analysis as confirmation to write. Create or update a
requirement document or GitHub intake only after explicit confirmation of the
reflected meaning. Existing
explicit authorization counts; do not ask for the same confirmation again.
Recording an effort overview follows the scoped authorization above.

## The confirmed intake

After the human confirms the reflected meaning, offer exactly these two exits
and let them choose for this idea:

- **Shape this further with my coworkers** — publish the confirmed meaning as
  one requirement document at `draft`, then stop. Creating the draft grants no
  GitHub label, Priority, issue, or delivery authority.
- **Small enough, just do it** — create the confirmed `needs-preparation`
  intake exactly as below, then stop.

Never select an exit from size, complexity, confidence, or any other rule. A
conversation may end with neither exit. The choice authorizes only that exit;
it does not authorize preparation, `ready`, Priority, or implementation.

### Publish a draft requirement

Use the installed MCP server's discovered tool schemas, so this path works from
a machine with only `ub`, its MCP server, and the shaping skill. Read the live
Editorial contract and active tag catalog through MCP, then create one document
with `kind: requirement`, `status: draft`, a concise description, applicable
catalog tags under that live contract, and blocks carrying the confirmed
problem, intended outcome, success evidence, constraints, trade-offs, and scope
boundary.
Preserve the human's language and do not invent missing product meaning. State
every unresolved human choice in the explicit lifecycle language the Editorial
contract requires of a Product Document.

Re-read the new document and verify that `list_docs` filtered to
`kind: requirement`, `status: draft` returns its uuid. Then return its title and
uuid. Do not create an issue, set Priority, or claim that a draft is planned.
The draft is where coworkers comment on exact text and raise decision
documents; its uuid is the stable handle for resumption.

### Resume a requirement

A later shaping conversation may resume a requirement by uuid, whether its
status is `draft` or already `planned`. Read it with `get_doc`; a title match is
not identity. Refuse to reinterpret another document kind as a requirement.
Gather every unresolved annotation on the requirement and every open entry in
its decision log. Read each open decision document, including its unresolved
annotations. A decision reference this replica cannot read is a visible
boundary to surface to the human, never an item to skip.

Walk through the open items one at a time. For each, first state what material
change you believe it asks for, then let the human choose: revise, reply and
resolve with a reason, decide an open decision, or leave it open. Act only on
that explicit disposition:

- revise the existing requirement or decision block by block with `edit_block`,
  `insert_block`, or `delete_block`; never recreate the document, churn an
  unchanged outcome block's id, or erase an unresolved choice without the
  human's disposition;
- reply to an annotation with `annotate`, naming its `thread_id`, the reason,
  and `resolved: true`; reopening is the same reply shape with
  `resolved: false` and the human's reason;
- edit an open decision in place and call `set_status` with `decided` only after
  the human confirms the choice and the document carries the required
  `Reconsidering` section; or
- make no write when the human leaves the item open.

Only a resolved annotation or a decided decision drops out of the next
resumption. Re-read affected documents after writes so the next item is based
on current block revisions and decision state.

When the human explicitly declares the requirement planned, set its status to
`planned` and ask them to group the product outcomes into the intakes they want.
This is their product grouping, not technical PR decomposition. Before creating
anything, enumerate open and closed issues with
`gh api --paginate "repos/uberblick-ai/uberblick-2/issues?state=all&per_page=100"`,
exclude pull requests, and inspect their bodies locally for an exact requirement
uuid in `Implements:` lines; do not depend on GitHub's full-text search index
for retry safety. Compare the exact outcome grouping the human confirmed. A
prior line covers a retry only when it names the same outcome block ids; a
uuid-only line matches only a uuid-only group. If a newly requested group
overlaps an earlier intake, show the overlap and create it only after the human
explicitly confirms it. Create only missing confirmed groups, so a retry after
a failed creation or an interrupted run does not duplicate an intake.

On resumption of an already-planned requirement, do not set the same status or
ask for the same lifecycle decision again. Confirm only the outcome grouping
needed for the missing intakes, then perform the same open-and-closed issue
search before creating them.

Each planned-outcome intake starts with contiguous lines in this order:

```text
Implements: <requirement uuid> [<outcome block ids, when used>]
Owner decision, <YYYY-MM-DD>: <the human's planned decision and its provenance>
```

Follow those lines with the confirmed intake sections below. Add only
`needs-preparation`: do not write `Depends-on`, `Touches`, `Parent`, Priority,
or `ready`. The issue-preparer later completes the machine-readable header and
grounds the contract. If the repository's `scripts/create-issue.mjs` helper is
available, use it with Request Source `Human`. Otherwise create with `gh`, leave
Request Source unset as the issue contract permits, and tell the human; use
`--repo uberblick-ai/uberblick-2` so no checkout is required, and promise no
additional failure record.

### Create a small intake

Text and voice conversations produce the same chosen-exit plus four-part handoff:

```text
Chosen exit: shape this further with my coworkers | small enough, just do it

Title: <concise behavioral title>

Goal or problem:
<what happens now, who is affected if relevant, and what outcome would be better>

Evidence or example:
<success evidence, reproduction, observation, screenshot/log pointer, or omitted>

Known constraints:
<decision principles, trade-offs, must-not-change behavior, scope boundaries,
and clearly marked unresolved human choices; or omitted>
```

Keep it as short as the user can still recognize. Omit empty optional sections
when handing text to another coordinator; omit `Chosen exit` from an issue body.
The GitHub form may render the section headings with empty values.

When the human chooses this exit, create the intake with
`needs-preparation` through `.github/ISSUE_SPEC.md`'s **Request source** path,
recording `Human` for the person's request. If its helper is unavailable, use
`gh issue create --repo uberblick-ai/uberblick-2`, leave Request Source unset,
and tell the human. Never infer or write Priority, `Depends-on`, `Touches`,
`Parent`, architecture, implementation detail, acceptance criteria, Pointers,
or `ready`. The
issue-preparer derives the technical contract from the current repository and
corpus under `.agents/protocols/issue-preparation.md`; a human choice that
remains unresolved may later take the existing `needs-decision` path.

If creation is not available, return the confirmed handoff to the coordinator.
Do not present a handoff as a created issue, a requirement document, or
preparation complete.

## Authority map

- This file: conversation → draft requirement and resumption, or confirmed
  intake.
- `.github/ISSUE_SPEC.md`: final issue schema and lifecycle.
- `.agents/roles/issue-preparer.md`: queue ownership, authority, and side
  effects for one preparation pass.
- `.agents/protocols/issue-preparation.md`: grounding, challenge, and recheck.
