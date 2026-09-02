# Issue shaping — conversation to intake

This protocol owns the conversation that turns a behavioral request into a
confirmed GitHub intake. It ends when a concise intake is handed off or created
with `needs-preparation`. It does not prepare the issue, decide that it is
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
issue only after explicit confirmation of the reflected intake.

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
