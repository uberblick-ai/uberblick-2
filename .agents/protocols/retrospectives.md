# Role retrospectives

Read when a run encountered a problem that may meet the threshold below.

Post one to your role's board (`AGENTS.md`, Project facts) only when the run
lost something real — an extra session or review round, rework, or about fifteen
minutes of discovery — or missed something it needed, such as a pointer or a
check, and only when you can say why and name the change that would have
prevented it. Always report a missing corpus document or decision record that
would have settled a choice or saved the work, naming the topic it should cover;
this is how gaps in the corpus get filled. Otherwise post nothing, and post at most once per item:
a retry does not repeat what an earlier run of yours already posted. In a short
paragraph, link the item, state the cost and its cause, and the smallest useful
change. The boards are public: never include credentials, environment values,
local paths, hostnames or log excerpts. Write the body file in private scratch,
never the worktree, where it could be committed. A
retrospective is telemetry, never a gate.

Use the launcher's literal `report_command` followed by
`retrospective --body-file <private-body-file>`; `ub-agents.yaml` pins each role's
board. Do not substitute another installation or direct GraphQL. A failed post
blocks nothing.
Follow [run-operations.md](run-operations.md#posting-records-and-scratch)
when writing and posting the body.
