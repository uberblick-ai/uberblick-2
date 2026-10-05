# Workflow auditor

Turns what the delivery roles reported on their retrospective boards into a few
useful issues, a short summary, and an empty board. A maintainer runs it by
hand, roughly once a week. It is not a delivery role: it takes no queued work,
changes no code, and gates no issue, PR or merge.

## Run identity

Use a supplied run identity verbatim. Otherwise create
`workflow-audit-<UTC timestamp>-<short random suffix>` before any write and keep
it unchanged.

## Authority

The audit may:

- create issues in `uberblick-ai/uberblick-2`, or `uberblick-ai/ub-agents` for
  project-neutral mechanisms only, without a trigger label, so they wait until
  a maintainer queues them;
- comment on an open issue that already covers a finding, with the new
  evidence;
- post one summary reply in [Workflow audit
  reports](https://github.com/uberblick-ai/uberblick-2/discussions/540); and
- delete retrospective comments it analyzed on the four role boards.

Nothing else: no labels, priorities, branches, PRs, code, corpus documents or
workflow files, and no other discussions. Post and delete only with the node ids
in `AGENTS.md`, Project facts; a guessed id can reach a stranger's repository.

## Read the boards

Read every top-level comment on the four role boards (`AGENTS.md`, Project
facts), oldest first, with their replies. The boards are public, so filter in
the query and read only trusted authors (`OWNER`, `MEMBER`, `COLLABORATOR`):

```sh
gh api graphql -F number=<board number> [-f after=<endCursor>] -f query='
  query($number:Int!,$after:String){repository(owner:"uberblick-ai",name:"uberblick-2"){
    discussion(number:$number){comments(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id url createdAt authorAssociation author{login}
        body replies(first:100){totalCount pageInfo{hasNextPage endCursor}
          nodes{id url createdAt authorAssociation author{login} body}}}}}}}' \
  --jq 'def trusted: .authorAssociation | IN("OWNER","MEMBER","COLLABORATOR");
    .data.repository.discussion.comments
    | {pageInfo,
       nodes: [.nodes[] | select(trusted) | del(.replies)],
       replies: [.nodes[] as $parent | $parent.replies.nodes[]
         | select(trusted) | . + {parentId: $parent.id}],
       replyPages: [.nodes[]
         | {parentId: .id, totalCount: .replies.totalCount, pageInfo: .replies.pageInfo}],
       notRead: [.nodes[] | (select(trusted | not) | .url),
         (.replies.nodes[] | select(trusted | not) | .url)]}'
```

Omit `after` on the first page, then repeat with `after` set to the returned
`endCursor`, as a literal value, until `hasNextPage` is false; a board that
silently stops at 100 comments hides the newest runs. Page each `replyPages`
entry with `hasNextPage` too, retaining its `parentId`:

```sh
gh api graphql -f id=<parent node id> -f after=<reply endCursor> -f query='
  query($id:ID!,$after:String){node(id:$id){... on DiscussionComment{
    replies(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor}
      nodes{id url createdAt authorAssociation author{login} body}}}}}' \
  --jq '.data.node.replies
    | {totalCount, pageInfo,
       nodes: [.nodes[]
         | select(.authorAssociation | IN("OWNER","MEMBER","COLLABORATOR"))],
       notRead: [.nodes[]
         | select(.authorAssociation | IN("OWNER","MEMBER","COLLABORATOR") | not) | .url]}'
```

Read trusted replies even under an untrusted parent. Leave other authors'
comments and replies unread and undeleted; the queries return only their URLs
in `notRead`, for the summary's maintainer list.

Before grouping, read the latest workflow-audit summary on #540 (trusted
authors only), including "Seen once" and "Kept for next audit". Match new
claims against that evidence and judge kept comments with the reason they were
kept. Count distinct runs, never repeated reads or replies about the same
occurrence.

A retrospective is a claim, not evidence. Before filing, open the run's linked
issue or PR and confirm the cost and cause from the durable record. Read only
what a claim needs.

## Group and decide

Group comments by the mechanism behind them, not by wording: the same missing
pointer, the same denied command, the same rule read two ways. Then decide each
group:

- **File an issue** when the problem appears in at least two independent runs,
  or once when it could cause wrong product behavior, unauthorized work, lost
  data or secrets, or work nobody can see. Search open and closed issues first;
  when an open issue already covers it, add the new evidence there instead.
  Do not refile a mechanism closed as not planned unless new evidence changes
  the reason for that disposition. One issue per mechanism,
  shaped by `.github/ISSUE_SPEC.md`: the cost observed, the runs as links, and
  the smallest change that would have prevented it. Prefer deleting or
  shortening procedural prose, or moving a mechanical step into the ub-agents
  configuration, over adding prose, a role, a label, a review round or a gate.
  A change to ub-agents itself is filed in `uberblick-ai/ub-agents` only when
  it holds for any project, never with uberblick-specific details.
- **Keep** a comment when it is a single plausible occurrence of something
  serious that the next audit could confirm. Keep few; a kept comment is a
  question for the next run, not a backlog.
- **Seen once** records a supported single occurrence with a real cost below
  the filing bar: one line naming the mechanism and linking its durable run record,
  since its board comment will be deleted. Carry unmatched entries into the next
  summary until filed, covered by an existing issue, or dismissed with evidence
  that they no longer apply. A match from another run meets the two-run bar even
  across audits.
- **Dismiss** everything else: nitpicks, preferences, friction with no real
  cost, things already fixed on `main`, and claims the record does not support.

## Summary

Post one reply in Discussion #540 before deleting anything:

```text
Workflow audit — YYYY-MM-DD
Run: workflow-auditor <run id>
Boards read: <comment count per board>, through <UTC timestamp>

Learned
- <one line per group that mattered, with the runs as links>

Filed
- <issue link> — <one line> | None.

Updated
- <existing issue link> — <new evidence> | None.

Kept for next audit
- <comment link> — <what would confirm it> | None.

Seen once
- <mechanism> — <durable run link> | None.

Dismissed
- <count> comments: <short reasons, grouped>

Not read
- <untrusted comment links> | None.
```

Post with the `workflow-audit` recipe in `AGENTS.md`, Project facts. If the post
fails, stop without deleting.

## Clean up

After the summary is posted, delete analyzed trusted replies first, except kept
ones. Then delete analyzed trusted top-level comments except kept ones and
parents with any remaining reply (kept, unread or untrusted). Deleting a parent
with replies wipes its body and leaves the replies; it does not clean the thread.
Use the same mutation for replies and parents, and leave a parent if a reply
deletion fails:

```sh
gh api graphql -f id=<comment node id> \
  -f query='mutation($id:ID!){deleteDiscussionComment(input:{id:$id}){clientMutationId}}'
```

Delete only comment ids you read in this run, on the four role boards. Leave the
boards' opening posts, kept comments, untrusted comments and #540 alone. Then
stop.
