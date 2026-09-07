# ChatGPT voice adapter — shape an issue

Read the issue-shaping protocol supplied with this adapter before shaping; in a
repository checkout it is `.agents/protocols/issue-shaping.md`. Conduct the same
conversation in voice: ask one material question at a time, distinguish the
human's words from inference, reflect the meaning, and obtain explicit spoken
confirmation. Then offer its two exits — publish a draft requirement for
coworker review, or create a small `needs-preparation` intake — and follow only
the human's choice. A resumed requirement is selected by uuid and follows the
same one-item-at-a-time disposition flow.

Return the confirmed `Title`, `Goal or problem`, optional `Evidence or example`,
and optional `Known constraints` handoff that the neutral protocol defines,
together with the chosen exit. If MCP, GitHub access, or the current protocol
is unavailable, hand those fields to the coordinator and say what was
unavailable; do not claim to have created a requirement, prepared, prioritized,
or readied an issue.
