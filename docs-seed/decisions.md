---
uuid: 6ea21fbd-aef9-4e69-873e-6c2a182e8894
title: Decisions
tags: [reference]
links: [9b4ea859-8304-4e11-9cc8-76232c16a4e5, 3231bff4-fb3c-4195-a83a-98031551ca68, 4575a744-1656-4699-af69-980a05d15fcc, b1d5d904-c8b6-46a1-a4df-22251875bcdb]
---

Standing decisions that govern current work, and where each one binds. A
decision here is settled: implement against it rather than reopening it, and
overrule it by saying so on the issue that would change it, not in passing.

## Shape of the system

- **Every document is a Yjs CRDT, and all document state lives in the Y.Doc.** Server-side tables hold derived indexes and nothing authoritative.
- **Document state syncs; auth state decides.** State that must merge between copies and survive offline lives in a Y.Doc; state that must be correct in one place at one time — which workspaces a hub serves, which credentials may open them, which are revoked — lives in the hub's own tables, never synced and never rebuilt from documents. This is a closed list, not a general licence for server-side state. The reasoning, and what losing those tables costs, is in the Architecture document.
- **Markdown is an export format, never storage.** There is no markdown import tool; the reader that brings seed documents in is one-way and not exposed.
- **Agent writes are block-scoped.** A whole-document replace tool must not exist, from any client.
- **Identity is uuids everywhere.** Titles and paths are display data; on conflict the title inside the document wins over the directory stub.
- **A workspace is a uuid with no default**, optionally decorated for display with a slug that is parsed off before it reaches a room, a token claim or a database filename.
- **The web editor is Tiptap with custom nodes over the schema-owned block shape**, decided over BlockNote, which rewrites foreign fragment shapes and strips undeclared attributes.
- **Unknown blocks degrade loudly** — a visible placeholder and an explicit export marker — and are never silently dropped.

## Operating it

- **The remote host never updates itself** (2026-08-25). No timer, no webhook, no polling loop: one deliberate command deploys, and a change to wire semantics is deployed with every client updated in the same sitting. There are no compatibility windows.
- **The hub binds loopback by default.** Its only credential is a shared development signing secret, so binding wider is a deliberate act, and a deployed bundle is supported on a private tailnet only.
- **Sharing waits for `ub share`** rather than shipping a friendly-sounding invite that could only mean handing over the signing key.
- **A browser gets no access by default** in the isolation design: the policy is granted per workspace by an explicit command, because inferring authority from a loopback address would turn a public uuid into a bearer credential.

## Documents about the product

- **The corpus is the status quo.** Documents answer what is true now; issues and pull requests answer what is changing. When work merges, the document is updated to the new status quo.
- **A document may also carry a decision already taken that is not yet code**, where the document says so explicitly. That is what lets mechanism and reasoning live in a document rather than in an issue body.
- **Live documents are authoritative for an initialised workspace.** The seed files are the current bootstrap snapshot for a new one: re-importing them never overwrites an existing uuid, and a change to the status quo updates its seed file before merge and the live document after.
- **Issues carry implementation detail only** — what, runnable acceptance criteria, scope. Shared context is cited from a document by title and uuid, never restated into an issue body.
- **The corpus is regenerable.** After the workspace-uuid cutover stranded the old rooms, the decision was to regenerate rather than migrate (2026-08-25) — and the corpus starts on one machine and moves with `ub remote promote`, which is the same verb any user takes.

## Changing the code

- **KISS, YAGNI, and least code wins.** The smallest diff that satisfies the issue; no speculative generality; prefer reusing or deleting over adding.
- **Boring dependencies, few of them.** Adding one is an architectural decision, not a convenience.
- **Do not overtest.** Test contracts and invariants, not implementation details.
- **Every piece of functionality starts as an issue**, is implemented on a branch, and merges only after its gates pass — the containerised review, the acceptance criteria, the requested reviews, and zero unaddressed remarks.
