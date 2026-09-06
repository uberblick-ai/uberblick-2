# Issue shaping — conversation to intake

This protocol owns the conversation that turns a behavioral request into a
confirmed GitHub intake. Use it when the owner wants to explore or shape new
functionality, even before they ask for an issue. Discussion may end with a
clearer direction or an unresolved question; issue creation is not required.
The intake path ends with a concise handoff or an issue created with
`needs-preparation`. It does not prepare the issue, decide that it is
`ready`, or replace `.github/ISSUE_SPEC.md`.

## Start with discovery, not a draft

Do not respond to a behavioral request by immediately writing an issue,
acceptance criteria, implementation plan, or proposed architecture. First
understand the request in the user's terms. Treat a suggested mechanism as
evidence about the desired outcome, not as a requirement, unless the owner
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
- unresolved choices that only the owner can make.

Repository facts, likely files, dependencies, implementation options, and edge
cases may help formulate a question. They are agent inferences until the owner
adopts them. Say which is which: use language such as "You said…" for an owner
statement and "I infer…" or "A possible implication is…" for an inference.

## Keep the effort oriented

For a substantial discussion, establish the intended outcome in one or two
sentences and use it to choose which questions matter next. Keep a compact
working overview of settled decisions, open questions, detail not yet clear
enough to specify, and work outside this effort. Ordinary small requests need
no overview. Refresh it when decisions change or the conversation resumes,
not after every message. Refer to issues by descriptive linked titles in prose;
retain the identifiers required by machine-readable records.

Separate an empirical uncertainty from an owner choice and an ordinary
engineering judgment. Read available evidence to answer factual questions;
ask the owner about unresolved intent or trade-offs; leave routine technical
choices to preparation and implementation. Do not reopen a settled owner
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
relevant effort issue. Once the owner authorizes that write, record a concise
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
- any unresolved owner choice, explicitly marked unresolved.

Ask the user to correct the meaning. Do not treat silence, a topic change, or a
request for more analysis as confirmation to write. Create or update a GitHub
intake only after explicit confirmation of the reflected meaning. Existing
explicit authorization counts; do not ask for the same confirmation again.
Recording an effort overview follows the scoped authorization above.

## The confirmed intake

Text and voice conversations produce the same four-part handoff:

```text
Title: <concise behavioral title>

Goal or problem:
<what happens now, who is affected if relevant, and what outcome would be better>

Evidence or example:
<success evidence, reproduction, observation, screenshot/log pointer, or omitted>

Known constraints:
<decision principles, trade-offs, must-not-change behavior, scope boundaries,
and clearly marked unresolved owner choices; or omitted>
```

Keep it as short as the user can still recognize. Omit empty optional sections
when handing text to another coordinator; the GitHub form may render their
headings with empty values.

If the user confirms issue creation, create this intake with
`needs-preparation` through `.github/ISSUE_SPEC.md`'s **Request source** path,
recording `Human` for the person's request. Never infer or write Priority,
`Depends-on`, `Touches`, `Parent`, architecture, implementation detail,
acceptance criteria, Pointers, or `ready`. The issue-preparer derives the
technical contract from the current repository and corpus under
`.agents/protocols/issue-preparation.md`; an owner choice that remains
unresolved may later take the existing `needs-decision` path.

If creation is not available, return the confirmed four-part handoff to the
coordinator. Do not present a handoff as a created issue or as preparation
complete.

## Authority map

- This file: conversation → confirmed intake.
- `.github/ISSUE_SPEC.md`: final issue schema and lifecycle.
- `.agents/roles/issue-preparer.md`: queue ownership, authority, and side
  effects for one preparation pass.
- `.agents/protocols/issue-preparation.md`: grounding, challenge, and recheck.
