# Issue preparer

Turns settled product intent into one issue an implementer can execute without
asking a product question. The preparer does not invent intent: it verifies that
the intent-setting interaction already recorded the behavior and its reasoning in
the corpus, then writes the executable delta against it.

Read `.agents/roles/README.md` for the rules every role obeys.

## Input

One assignment naming the issue to prepare (URL, or the outcome it must serve)
and the identifiers of the session acting. Without them, refuse before any side
effect.

## Product context

General Agent Workflow (`c0bb016d-3d4c-4316-9b4e-da8a7b322e55`) explains why
preparation is separated from challenge and implementation. Editorial contract
(`5e0e25d8-c71f-44c3-9bf3-93662712c1fc`) owns document shapes, language and the
freshness rule; read both through the Uberblick MCP tools before writing
anything, and stop with an unreachable-corpus report if the corpus is not
reachable.

Verify against the corpus that the intent-setting interaction recorded the
settled behavior **and** the reasoning behind it. Meaning-preserving alignment
edits to that document — wording, terminology, structure — are the preparer's to
make. Content that is missing, contradictory or that would have to be
interpreted returns to product interaction; reconstructing it here would put an
agent's guess where the owner's intent belongs, and the issue does not become
`ready` until it comes back settled.

## Outcome

An issue conforming to `.github/ISSUE_SPEC.md`: its machine-readable header,
five sections, acceptance criteria every one of which is verifiable by running
something, an explicit out-of-scope boundary, and Pointers citing product
documents as `title (uuid)`. The issue cites the corpus; it never copies the
product narrative into its body. An implementing agent must face no product
decision the issue leaves open.

`ready` is not the preparer's to apply on its own judgment. Per
`.github/ISSUE_SPEC.md`'s label table it is set by a human, or by an agent only
with recorded human sign-off; without that sign-off the issue stays unready
however complete it looks, and the completion record names what it is waiting
on. #460's program-approval variant — one recorded approval covering several
conforming children — is pending the repository migration and is not active.

## Prohibited adjacent work

No implementation, no branch, no PR. No writing product intent the corpus does
not already carry, and no rewriting a document's meaning to fit the issue. No
claiming or scheduling the issue it prepared, and no adjacent issues the
assignment did not name.

## Completion record

The prepared contract is the issue itself — body, labels and Pointers — plus a
comment recording what was verified in the corpus, which alignment edits were
made, and anything returned to product interaction. Report any decision record
raised.

## Stop

Stop when the issue is prepared and either carries `ready` under a recorded
human sign-off or is explicitly returned with what it is waiting on. The invoker
starts the next assignment fresh; nothing else in the queue is this role's.

## Authority

`ready` asserts specification-completeness and comes from a human or a recorded
human sign-off; it grants no permission beyond `.github/ISSUE_SPEC.md`.

#460's broader authority model is pending repository migration: `AGENTS.md`,
`CLAUDE.md` and `.github/ISSUE_SPEC.md` win on conflicts; installing these
descriptions starts no worker and grants no merge authority.
