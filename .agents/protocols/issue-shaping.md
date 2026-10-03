# Issue shaping — intent to a focused intake

Use this protocol when a human explores functionality or discusses an issue,
even before asking to file it. The goal is to condense their intent into the
smallest useful product outcome: an MVP with clear scope, not a technical plan.
Discussion may end without creating anything. The issue preparer owns technical
grounding, acceptance criteria, dependencies and implementation-sized work.

## Narrow the intent

Actively help a broad or rambling idea converge. Identify the core problem and
propose the smallest outcome that would solve it; distinguish essential behavior
from optional additions and later ambitions. Ask one focused question at a time
when its answer changes the outcome, scope or trade-off. Questions need not be
the opening move. If the intent is already clear, proceed without a questionnaire
or repeating settled answers.

Treat a suggested mechanism as a clue to the desired outcome unless the human
makes it binding. Do not drift into architecture, file lists or exhaustive edge
cases. Read available evidence for factual uncertainty, ask about unresolved
human choices, and leave ordinary engineering judgment to preparation and
implementation. Distinguish verified facts, human decisions and your inferences.

An MVP must still be useful and preserve essential guarantees. Do not silently
drop requested behavior, safety or data-preservation constraints to shrink it.
Offer a narrower first outcome for the human to adopt; keep optional follow-ups
outside that intake without automatically creating more issues. Do not force a
cohesive outcome into tiny technical fragments. Reopen a settled choice only
when new evidence or changed direction conflicts with it, naming the conflict.

## Keep the effort oriented

For a larger effort, keep a compact overview of the intended outcome, settled
decisions, open questions and deferred work. Refresh it when direction changes
or the conversation resumes, not after each message. Small requests need none.
Preserve it on an existing effort issue only when authorized, as a short comment
linking the source decisions; this grants no queue or relationship changes.

Before suggesting a spike, name the decision it informs, the uncertain
assumption and the cheapest observation that could support or overturn it.
A bounded negative result can answer the question; implementing the eventual
feature is not the spike's goal. Shaping uses read-only exploration; experiments
need the authorization and repository rules that apply to them.

## Confirm the scope and destination

Reflect the meaning briefly: the problem and useful outcome, an example of
success, essential constraints, and what is deferred or out of scope. Mark any
unresolved human choice. If no priority was given, ask for it, suggesting a value
when useful; never infer or assign one yourself.

Write only after explicit authorization for that meaning and destination.
Existing authorization counts: “file it” or “queue it for preparation” already
chooses an issue. Do not repeat a confirmation or menu the human has answered;
silence and a request for more analysis are not approval.

When the destination is undecided, offer the two supported paths:

- **Discuss with coworkers:** publish a draft requirement.
- **Create an intake:** file the confirmed scope with `needs-preparation`.

Never choose from size or confidence alone. Neither path authorizes `ready` or
implementation. For shared drafts and requirement resumption by UUID, read
[requirement-resumption.md](requirement-resumption.md) only when that path applies.

## Create a small intake

Keep the handoff short enough for the human to recognize:

```text
Title: <concise behavioral title>

Goal or problem:
<current problem and smallest useful outcome>

Evidence or example:
<success example, observation or reference; omit if absent>

Known constraints:
<essential behavior, trade-offs, scope boundaries and unresolved human choices;
omit if absent>
```

Create it with `gh issue create --repo uberblick-ai/uberblick-2 --label
needs-preparation`. Add only the `priority:<value>` the human stated, recording
that decision in a comment; otherwise leave priority unset. Tell the human to
set Request Source `Human` in the sidebar. Do not invent `Touches`, relationships,
architecture, acceptance criteria, Pointers or `ready`: the preparer supplies
the grounded contract under `issue-preparation.md` and `.github/ISSUE_SPEC.md`.

Stop after the authorized draft or intake is created. If creation is unavailable,
return the handoff and chosen destination to the coordinator, stating the
limitation; never claim it was created, prepared or readied.
