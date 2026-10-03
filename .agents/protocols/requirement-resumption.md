# Shared requirements — publication and resumption

Read this procedure only when the human chooses a shared draft or supplies a
requirement UUID to resume. `issue-shaping.md` owns intent, scope and write
authorization; this file preserves the document and retry-safety mechanics.

## Publish a draft requirement

Use the installed MCP server's discovered tool schemas, so this path works from
a machine with only `ub`, its MCP server, and the shaping skill. Read the
Editorial contract (`5e0e25d8-c71f-44c3-9bf3-93662712c1fc`) and the active tag
catalog through MCP, then create one document
with `kind: requirement`, `status: draft`, a concise description, applicable
catalog tags under that live contract, and blocks carrying the confirmed
problem, intended outcome, success evidence, constraints, trade-offs, and scope
boundary.
Preserve the human's language and do not invent missing product meaning. State
every unresolved human choice in the explicit lifecycle language the live
editorial document requires of a Product Document.

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
annotation on each decision document in its log that this replica can read, and
every log entry whose own status is still `open`. Read those decision documents
for their annotations whatever their status: a decision's status and its
threads' `resolved` flags are independent, so deciding a decision leaves an
unresolved objection on it unresolved and still owed a disposition. A decision
reference this replica cannot read is a visible boundary to surface to the
human, never an item to skip.

Walk through the gathered items one at a time. For each, first state what
material change you believe it asks for, then let the human choose: revise,
reply and resolve with a reason, decide an open decision, or leave it open. Act
only on that explicit disposition:

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

Only a resolved annotation drops out of the next resumption, and a decided
decision drops out only as a decision item: its own unresolved annotations stay
in the walk. Re-read affected documents after writes so the next item is based
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

Each planned-outcome intake starts with this line:

```text
Implements: <requirement uuid> [<outcome block ids, when used>]
```

Follow it with the confirmed intake sections in `issue-shaping.md`. Add only
`needs-preparation`: do not write `Touches`, relationships, Priority, or
`ready`. The issue-preparer later completes the machine-readable header and
grounds the contract. Record the human's planned decision as a comment on the
intake; it is their approval only when it comes from their own account
(`.github/ISSUE_SPEC.md`), so when this session posts as `uberblick-agent`, ask
them to confirm it there. Create it with `gh issue create --repo
uberblick-ai/uberblick-2`, so no checkout is required, and tell the human to set
Request Source `Human` in the issue sidebar.

