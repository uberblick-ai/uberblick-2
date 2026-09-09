# Agent entry point

These instructions apply to interactive sessions and delivery roles alike.
Runtime-specific files supply metadata and invocation only.

## Find the right authority

- **MCP corpus:** product intent, adopted principles, architecture and guarantees,
  and the human explanation of the workflow. Start from Product Overview and
  Information types and sources of truth when unfamiliar with the project.
  Discover their current UUIDs through the corpus catalog before citing them.
- **Local protocols:** exact steps, permissions, records and operational gates.
- **Code and tests:** implemented behavior. Comments explain nearby non-obvious
  constraints; they do not authorize product or process changes.
- **GitHub:** authorized work scope, owner decisions, claims, reviews and evidence.

A discrepancy is a gap to resolve, not permission to silently override another
source. Distinguish implemented behavior from agreed future direction. Apply
settled owner authorization without asking for it again; escalate only the
unresolved choice beyond that authorization.

## Read the project's bindings

These instructions are a workflow a project adopts, so they name no repository,
base ref, discussion, owner, corpus document or validation command of their own.
Every such value is the adopting project's, declared once in its
`.agents/launch.json` under `project` and read with
`node scripts/agent-binding.mjs <binding>` — for example
`node scripts/agent-binding.mjs project.repository`. The helper prints the
value alone, or exits non-zero naming the binding and the file and key it
searched. Resolve a binding immediately before the operation that needs it, so
a missing one costs a message rather than a claim, a comment or a push against
the wrong repository; nothing here falls back to another project's values.
`.agents/requires.json` declares the bindings and resources this workflow needs,
and `.agents/audits/` and `.agents/skills/` sit outside it as this project's own.

## Read for the action

Use `gh` CLI for GitHub reads and writes; use the project's corpus MCP server
for the product corpus. GitHub MCP is not required.

MCP access is expected for every session. Discover documents through `list_docs`
and search, then read the relevant documents and linked decisions. Do not load
the whole corpus. If required context cannot be read, stop dependent decisions
or edits and report the concrete failure; diagnosis and independent mechanical
work can continue. Classify work as mechanical only after establishing that
its relevant guarantees are understood; a small diff is not evidence of that.
If a required local contract cannot be read, stop the dependent action.

The preparer scans the corpus catalog and supplies relevant document links and
reasons in the issue. Implementers start from that reading guide, read the live
documents, and expand discovery when code or findings reveal missing context.
A pointer is a route to the source, not a substitute for reading it.

- **Discuss or shape:** `.agents/protocols/issue-shaping.md` plus relevant corpus;
  it governs the human’s choice of draft requirement or confirmed intake, and
  resuming a requirement by UUID. A draft grants no queue authority.
- **Assigned role:** `.agents/roles/<role>.md`; follow its pickup order. Empty
  queue checks do not require a corpus sweep or implementation worktree.
- **Before role side effects:** `.agents/roles/README.md` for shared ownership.
- **Prepare an issue:** `.agents/protocols/issue-preparation.md` and
  `.github/ISSUE_SPEC.md` for the issue contract.
- **Build or validate:** `.agents/development.md` and
  `.agents/protocols/delivery-policy.md` before editing.
- **Review or integrate:** `.agents/protocols/delivery-policy.md`, then the
  review or integration procedure relevant to the current action.
- **Edit corpus:** resolve and read `project.context.editorial`; update the
  owning document rather than copying its content into repository instructions.
  Corpus edits must stay
  within recorded authorization: update descriptions of delivered behavior,
  but do not weaken a guarantee or expand agent authority through a doc edit.
  An unsettled change to those commitments requires an owner decision.

When instructions come from a different checkout than the code being examined,
identify both sources and revisions. Verify code and path claims at the stated
code revision; an instruction in the control checkout is not evidence it shipped.

Read each source when needed and reuse it within the session. Refresh affected
context when the assignment, governing decision or relevant source changes.

## Change instructions coherently

Process changes use the repository review route unless the owner explicitly
requests an attended exception. Agent-authored process changes require one
cross-runtime challenge before landing. Update callers when moving a protocol. Before
landing, identify ready issues made stale by moved or contradicted instructions;
return those issues to preparation with the commit and specific affected rule.
Do not relabel unrelated work or treat a path change as a new product decision.
