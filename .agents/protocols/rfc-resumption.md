# Shared RFCs — publication and resumption

Read this procedure only when the human chooses to discuss with coworkers or
supplies an RFC UUID to resume. [issue-shaping.md](issue-shaping.md) owns intent,
scope and write authorization; this file preserves document and retry safety.

## Publish or reuse an RFC

Act only after the human chooses this destination. Use the installed MCP
server's discovered tool schemas, so this path works with only `ub`, its MCP
server and the shaping skill. Read the live regular-document and RFC model by
purpose under [AGENTS.md](../../AGENTS.md#read-for-the-action); publication needs
no corpus authoring contract, RFC template or options outline.

Create a regular document with the human's confirmed content as free-form blocks
in their language, omitting `kind` and `status`. Do not seed a recommendation,
options outline or missing product meaning. Alternatively, read an existing
regular document by UUID and reuse it only when the human confirms that choice;
preserve its existing content and comments, revising only text they authorize.
Archived reuse follows the read-only resumption rule below.

For a live RFC, discover the workspace's tag catalog with `list_tags` and apply its ordinary
`rfc` tag to the RFC only, preserving existing tags on a reused document. MCP
cannot create tags: if the catalog has no `rfc` tag, publish without it and tell
the human. Re-read the RFC to verify its confirmed content and return its title
and UUID, the stable handle for resumption. Publication creates no issue,
Priority or decision record on its own.

## Connect a decision topic

When the human wants a decision topic for a shaped choice, apply
[shaping's recorded-choice rules](issue-shaping.md#record-durable-choices) and
read live decision-lifecycle guidance. Create or reuse the RFC deliberately
first; connecting a topic never creates an RFC or tags or edits the related page.

Through MCP, create an `open` first record with `related` naming its regular
owning page and `discussion` naming the confirmed RFC. To reconsider an answer,
create an `open` successor with `supersedes` naming its predecessor and
`discussion` naming this proposal's RFC; successors do not inherit discussion.
Use one to three short answer blocks with a brief reason when there is a
confirmed answer or recommendation; an unsettled first record may be empty.
Put guidance on the related page and detailed options, evidence and debate in
the connected RFC or linked GitHub item, not in a TL;DR, heading or Links section
on the record.

Use `set_status` to settle, reject or withdraw under the existing recorded-answer
rules below and the installed schemas. All decision content and lifecycle
writes use MCP; the web supports reading and comments. Surface a refused
connection, including an archived target, rather than restoring a document or
creating a replacement without the human's instruction.

## Resume an RFC

Read the supplied UUID with `get_doc`; a title match is not identity. Documents
stored with the former requirement kind read as regular documents and use this
same walk. An archived RFC remains readable: read its content and comments,
but do not edit, restore, archive again or delete it unless the human explicitly
asks. If a disposition needs an archived-document write, explain the boundary
and leave it pending; resumption itself grants no restoration authority.

Gather every unresolved annotation on the RFC. For each topic in its `decisions`
relations, read the representative, `inForce`, every `pending` record and every
`conflicts` record by UUID, deduplicating identical UUIDs. Do not filter by the
representative's `status`: a decided representative can have several pending
successors. Check `list_docs` with `kind: decision` for records whose `discussion`
names this RFC as well, with `include_superseded: true` to find connections in
earlier records; indexed page links can lag. An absent discussion cache is
unknown, not an absent connection: read that record to check it. Include each
connected live topic's full resolution, not only the record that links the RFC. Archived topics
are read-only and omitted from the page's live topics; they hold no open item.

Gather unresolved annotations from all these records. Follow every predecessor
and successor reference within each topic, reading each UUID once, so objections
on earlier, rejected or withdrawn records survive a change of answer. Gather
each pending record as an open decision item and each non-empty conflict group
as an item naming all competing records. A decision's status and its threads'
`resolved` flags are independent: deciding a record leaves unresolved objections
owed a disposition. Show any reference this replica cannot read to the human,
with the failed UUID and refusal; never skip it or treat the walk as complete.

Read resolution from current MCP results. With A decided and B and C open,
gather both proposals and their unresolved annotations even though A represents
the topic. A stays in force until a person approves a successor. After approving
B, C remains pending; rejecting C requires its own disposition. A conflict has
nothing in force: present every competing answer for the person to resolve,
even when no record is pending.

Walk the gathered items one at a time. State the material change you believe
each asks for, then let the human explicitly choose: revise, reply and resolve
with a reason, decide an open record, reject a proposal with a reason, withdraw
an open proposal, resolve a conflict, or leave the item unresolved. Act only on
that disposition:

- Revise the existing live RFC or open decision block by block with
  `edit_block`, `insert_block` or `delete_block`. Re-read before writing and use
  the returned current text and `rev` for edits. On a stale revision, re-read
  and reconcile the authorized change with concurrent edits before retrying;
  obtain a new disposition if its meaning changes. Never recreate the document,
  churn unchanged outcome block IDs or erase an unresolved choice without its
  disposition. Re-read before inserts or deletes too; preserve concurrent text
  and comments and surface any conflicting change.
- Change a decided record only through an `open` successor with `supersedes`
  and an explicitly chosen `discussion` where applicable, using the short
  answer shape above. Never edit a decided title or answer block.
- Reply to an annotation with `annotate`, naming its `thread_id`, the reason
  and `resolved: true`. Reopening uses the same reply shape with
  `resolved: false` and the human's reason. An archived RFC's annotations remain
  in the walk even when it cannot accept the reply.
- Finish an open record's short answer while editable, then call `set_status`
  with `decided` and `answer: {who, when, where}` recording the person's actual
  choice and source. A successor takes effect only through that approval,
  never an agent stance.
- Reject an open proposal, an agent stance or a side of a decided conflict
  through `set_status` with `rejected`, the person's non-empty `reason` and
  recorded `answer`. For a conflict, reject only records the person declines,
  re-reading after each write until the chosen answer is in force. Obtain a
  disposition for any newly surfaced competitor before further writes; never
  infer rejection from another record's approval.
- Withdraw an open proposal through `set_status` with `withdrawn`; it needs no
  recorded answer. Decided records cannot withdraw; rejected and withdrawn
  records are final. Use the installed schemas for exact calls and refusals.
- Make no write when the human leaves an item unresolved.

Only resolved annotations drop out of the next walk. A topic drops out as a
decision item only when it has no pending record and no conflict; unresolved
annotations remain. Re-read affected documents and the RFC's topic relations
after writes, refreshing resolution and newly arrived comments or records before
the next item. Approving B and rejecting C leaves B in force, but their unresolved
annotations still need dispositions.

## Create intakes from an RFC

When the human asks for delivery intakes, confirm their outcome grouping, not a
technical PR decomposition. Set no document status. Before creating anything,
enumerate open and closed issues by trusted authors (`AGENTS.md`), filtering
in the command so no other body reaches you:
`gh api --paginate "repos/uberblick-ai/uberblick-2/issues?state=all&per_page=100"
--jq '.[] | select(.pull_request == null) | select(.author_association == "OWNER"
or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
| {number, body}'`. Inspect those bodies locally for this exact document UUID
in `Implements:` lines; do not rely on GitHub's full-text search index for retry
safety. Compare the exact confirmed outcome grouping. A prior line covers a
retry only when it names the same outcome block IDs; a UUID-only line matches
only a UUID-only group. Show overlaps with earlier intakes and create an
overlapping group only after explicit human confirmation. Create only missing
confirmed groups, including after a failed creation or interrupted run.

Each intake starts with:

```text
Implements: <regular document uuid> [<outcome block ids, when used>]
```

Follow it with the confirmed intake sections and account-specific labels in
[issue-shaping.md](issue-shaping.md). Do not write `Touches`, relationships,
Priority or `ready`; preparation completes the header and grounds the contract.
Record the human's requested outcomes and approval as a comment on the intake.
It satisfies [ISSUE_SPEC's approval gate](../../.github/ISSUE_SPEC.md) only when
posted from their own account, so a session posting as `uberblick-agent` asks
them to confirm there. Create with `gh issue create --repo
uberblick-ai/uberblick-2` and tell the human to set Request Source `Human` in the
sidebar. No RFC lifecycle action is part of intake creation or retry.
