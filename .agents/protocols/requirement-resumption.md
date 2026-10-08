# Shared requirements — publication and resumption

Read this procedure only when the human chooses a shared draft or supplies a
requirement UUID to resume. `issue-shaping.md` owns intent, scope and write
authorization; this file preserves the document and retry-safety mechanics.

## Publish a draft requirement

Use the installed MCP server's discovered tool schemas, so this path works from
a machine with only `ub`, its MCP server, and the shaping skill. Discover and read
current requirement-authoring and lifecycle guidance by purpose using the catalog,
search and current tags under [AGENTS.md](../../AGENTS.md#read-for-the-action).
If required authoring rules are missing, report that gap and stop publication;
do not invent a replacement contract. Then create one document
with `kind: requirement`, `status: draft`, a concise description, applicable
catalog tags under that live contract, and blocks carrying the confirmed
problem, intended outcome, success evidence, constraints, trade-offs, and scope
boundary.
Preserve the human's language and do not invent missing product meaning. State
every unresolved human choice in the explicit lifecycle language the discovered
requirement guidance requires.

Re-read the new document and verify that `list_docs` filtered to
`kind: requirement`, `status: draft` returns its uuid. Then return its title and
uuid. Do not create an issue, set Priority, or claim that a draft is planned.
The draft is where coworkers comment on exact text and raise decision
documents; its uuid is the stable handle for resumption.

## Resume a requirement

A later shaping conversation may resume a requirement by uuid, whether its
status is `draft` or already `planned`. Read it with `get_doc`; a title match is
not identity. Refuse to reinterpret another document kind as a requirement.
Gather every unresolved annotation on the requirement, every unresolved
annotation on each readable decision document referenced by its log, and every
record in each topic row's `pending` as an open decision item, plus every
non-empty `conflicts` group as a decision item naming all its records. Do not
select topic rows by their representative's `status`: the row may be `decided`
while several successors are pending. Read the representative, `inForce`, `pending`
and `conflicts` records by UUID, deduplicating identical UUIDs, for annotations
whatever their status. For annotations, also follow those reads' predecessor
and successor references within the topic, reading each UUID once so earlier
or rejected records' unresolved objections survive a change of answer. A
decision's status and its threads' `resolved` flags are independent, so deciding
a decision leaves an unresolved objection unresolved and still owed a
disposition. A decision reference this replica cannot read is a visible
boundary to surface to the human, never an item to skip.

Read topic resolution from the live MCP results and discover any governing
decision-lifecycle guidance by purpose. With A decided and open successors B and C, gather B and C and
both records' unresolved annotations even though A represents the topic.
A stays in force until a person approves a successor; a pending recommendation
does not replace it. After approving B, a person who declines C rejects it
rather than deciding it just to clear the pending item. A conflict has nothing
in force; present its competing answers for the person to resolve, even when
there is no pending record.

Walk through the gathered items one at a time. For each, first state what
material change you believe it asks for, then let the human choose: revise,
reply and resolve with a reason, decide an open decision, reject a proposal
with a reason, resolve a conflict, or leave the item unresolved. Act only on
that explicit disposition:

- revise the existing requirement or an open decision block by block with
  `edit_block`, `insert_block`, or `delete_block`; never recreate the document,
  churn an unchanged outcome block's id, or erase an unresolved choice without the
  human's disposition;
- change a decided record only by creating an `open` successor through
  `create_doc`, naming the predecessor in `supersedes`; never direct a block,
  title or decision-line edit of a decided record (`decision_read_only`);
- reply to an annotation with `annotate`, naming its `thread_id`, the reason,
  and `resolved: true`; reopening is the same reply shape with
  `resolved: false` and the human's reason;
- finish an open record's text while it is editable, then call `set_status`
  with `decided` and `answer: {who, when, where}` recording the person's actual
  confirmed choice and its source. A successor takes effect only through that
  approval, never an agent stance. No `Reconsidering` section is required;
  use the installed MCP schemas for the exact call and refusals;
- reject an open proposal, an agent stance, or a side of a decided conflict
  through `set_status` with `status: rejected`, the person's non-empty `reason`
  and `answer: {who, when, where}`. To resolve a conflict, reject only the
  records the person declines, re-reading the topic after each write until the
  chosen answer is in force. If new competing records surface, obtain their
  disposition before further writes. The installed MCP schemas define the exact
  call and refusals; never infer rejection from approval of another record; or
- make no write when the human leaves the item unresolved.

Only a resolved annotation drops out of the next resumption. A topic drops out
as a decision item only when it has no pending record and no conflict;
deciding one successor does not drop another pending successor. Approving B
and rejecting C leaves B in force with no pending record or conflict. Its
records' unresolved annotations stay in the walk. Re-read affected documents
and the requirement's log after writes so the next item is based on current
block revisions and decision state.

When the human explicitly declares the requirement planned, set its status to
`planned` and ask them to group the product outcomes into the intakes they want.
This is their product grouping, not technical PR decomposition. Before creating
anything, enumerate open and closed issues by trusted authors (`AGENTS.md`), filtering
in the command so no other body reaches you:
`gh api --paginate "repos/uberblick-ai/uberblick-2/issues?state=all&per_page=100"
--jq '.[] | select(.pull_request == null) | select(.author_association == "OWNER"
or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
| {number, body}'`, and inspect those bodies locally for an exact requirement
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

Each planned-outcome intake starts with this line:

```text
Implements: <requirement uuid> [<outcome block ids, when used>]
```

Follow it with the confirmed intake sections in `issue-shaping.md`. Label it as
`issue-shaping.md` describes for this session's account: do not write `Touches`, relationships, Priority, or
`ready`. The issue-preparer later completes the machine-readable header and
grounds the contract. Record the human's planned decision as a comment on the
intake; it is their approval only when it comes from their own account
(`.github/ISSUE_SPEC.md`), so when this session posts as `uberblick-agent`, ask
them to confirm it there. Create it with `gh issue create --repo
uberblick-ai/uberblick-2`, so no checkout is required, and tell the human to set
Request Source `Human` in the issue sidebar.
