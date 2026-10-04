# Decision editing in context (#844)

## Verdict

Use a modal for the first production container. The existing Radix-backed
dialog supplies the interaction boundary a second full document editor needs,
while a second `useRoom` connection and the existing `EditorPane` preserve the
decision's own Y.Doc, status, presence, undo manager, and annotation writes.
The routed requirement stays mounted at the same address behind the modal.

This is a recommendation, not an adopted product decision. The experiment
does not settle whether an open decision needs its own address, how its
conversation should share screen space with the requirement, or which editor
chrome belongs in the compact container.

## Reproduction artifact

The disposable implementation and its browser proof are intentionally
unmerged. They are kept under the tag
`archive/spike/844-decision-in-context-prototype` at commit
[`d61323b184a5db325022ccb561ba0f06ef362f94`](https://github.com/uberblick-ai/uberblick-2/commit/d61323b184a5db325022ccb561ba0f06ef362f94).
To reproduce from that exact artifact:

```sh
git switch --detach d61323b184a5db325022ccb561ba0f06ef362f94
mise run install
mise run e2e -- --grep 'decision record in context'
```

The branch also passes `mise run lint` and `mise run typecheck`. The focused
Chromium scenario creates a requirement and attached decision through a real
`ub mcp serve`, opens the real web bundle against a real hub, and exercises the
modal rather than substituting a component fixture.

## What the prototype proves

The requirement's decision log resolves the schema-owned `decisions` slot
against the directory and presents the decision title and Open state. Opening
that entry acquires the decision's room over the socket the page already uses
and mounts a second ordinary `EditorPane` inside the existing dialog wrapper.
The requirement's URL, title, blocks, and annotations remain unchanged.

While both documents are mounted, an MCP `edit_block` to the decision appears
live in the modal. Text typed in the modal is then returned by `get_doc` for the
decision, not the requirement. Selecting that text and using the existing
Comment affordance creates one thread in the decision's annotations while the
requirement still has none. The proof therefore crosses the real transport and
the two Y.Docs in both directions; it is not merely a layout demonstration.

The prototype deliberately reuses the complete document pane. That is useful
evidence about integration resistance, but not the proposed final
composition: the duplicate document actions, copy control, full status line,
and wide reading measure should be selected deliberately for a production
modal.

## Container comparison

### Inline expansion

`Disclosure` is already local and keeps a closed subtree mounted, so an inline
reader is cheap. A collaborative editor is not. The routed `EditorPane` owns
the document column's measure, block gutter, scroll container, status chrome,
and selection affordances; nesting another pane in that column introduces a
second reading surface and scroll boundary without any framework-owned focus
or dismissal behavior. The requirement remains maximally visible, but the
decision competes directly with it for vertical space.

Inline expansion also does not reduce the main integration gap: the Threads
rail and `ThreadFocus` still belong to the routed room. Keeping the decision
subtree mounted while collapsed would retain its room, awareness, editor, and
undo state even when invisible; unmounting it would discard them. Production
would need to choose that lifecycle rather than inheriting it accidentally
from `Disclosure`.

### Popover

The local Radix-backed popover is a good compact-control primitive, but a poor
full-editor container. Collision handling, an anchored width, and lightweight
dismissal help menus and pickers; they constrain a multi-block editor with a
floating selection toolbar, comment composer, presence, and its own scrolling.
A non-modal popover also leaves the requirement interactive, creating two live
editing and keyboard targets at once. Making it large, focus-contained, and
background-isolating would reproduce dialog behavior through exceptions.

Popover met the most resistance and offers no compensating product advantage
for the complete read-edit-comment journey. It remains plausible for a later
read-only decision preview, which is a different outcome.

### Modal

The existing dialog already owns the relevant hard parts: a portal independent
of the document column, focus containment, background isolation, Escape and
outside-click dismissal, and focus restoration to the decision-log entry. It
accepted a second complete `EditorPane` without a new dependency or a new
editing model. The parent remains mounted and its address remains unchanged,
so closing returns to the same requirement context.

The cost is visual rather than architectural: a modal covers much of the
context it preserves. A production composition should leave enough of the
requirement visible to orient the reader and should avoid presenting every
piece of full-page chrome merely because the reused pane has it. Of the three
containers, this is the smallest boundary that is already robust enough for
editing and commenting.

## Material limitations and open choices

- **Address and history.** The shell's address bar remains the requirement's
  selection. The prototype gives the open decision no route or history entry,
  so reload and Back cannot restore or close it and a link cannot open the same
  in-context state. The nested pane's existing Copy link still points at the
  decision's full-page address. Product needs to choose whether the modal is
  intentionally transient, encoded in the URL, or paired with a shareable
  decision link that still opens a full page.
- **Threads and focus.** `ThreadsPane`, its drawer state, and `ThreadFocus` are
  held by the app shell for the routed requirement. The prototype proves that
  the existing composer writes a decision-local annotation, but intentionally
  discards its focus callback and offers no decision conversation rail. A
  production modal needs its own decision-bound rail and focus state, or an
  explicit shell rule that swaps the global rail to the active document and
  restores the requirement's state on close.
- **Presence, status, and undo.** Each editor instance correctly receives its
  own room status, awareness view, collaboration plugin, and undo manager. The
  same person consequently occupies both rooms while the modal is open.
  Closing releases the decision room when nothing else holds it, so reopening
  hydrates a fresh editor and loses editor-local undo history, selection, and
  scroll position. Production must say whether that session boundary is
  acceptable; persisted document content is unaffected.
- **Keyboard and dismissal.** Radix supplies the right modal defaults, but the
  combined behaviors still need browser proof: initial focus should land in a
  deliberate reading or editing target; Escape in a link or comment composer
  should close that inner affordance before it closes the modal; outside-click
  dismissal must not obscure the fact that edits are applied immediately; and
  close must restore focus to the exact decision-log entry. Narrow screens,
  virtual keyboards, IME composition, and background scroll also remain
  untested.
- **Archived, missing, and changing references.** The log can already retain an
  unavailable reference, and the prototype disables it. It does not exercise a
  decision being archived, removed from the log, or changing state while open.
  Those transitions need explicit close/read-only behavior rather than a stale
  modal.

## Independently deliverable production slices

1. **Read-only log and modal — S.** Observe `readDecisions`, render ordered
   available and unavailable entries on requirement documents, open a
   decision-room modal with title, Open or Decided state, and ordinary blocks,
   and keep the requirement route fixed. Prove focus, dismissal, archived
   references, and no write surface.
2. **Collaborative decision editing — M.** Admit writes only from the
   decision room, add the compact room-specific status and presence the modal
   actually needs, and define close/reopen undo and draft behavior. Prove MCP
   and second-browser edits in both directions.
3. **Decision-local conversations — M.** Put the existing comment composer and
   a decision-bound thread view in the modal, with independent `ThreadFocus`,
   resolve/reopen/reply behavior, and focus restoration. Prove that every
   annotation and highlight stays in the decision Y.Doc.
4. **Restorable in-context addressing — M.** If the owner decides the open
   decision needs an address, encode and parse that state without replacing the
   requirement as the routed document; define Back, reload, copied-link, and
   unavailable-decision behavior. If the owner chooses a deliberately
   transient modal, this slice becomes a short documented boundary rather than
   implementation work.

These slices require no new editor model, comment system, or runtime
dependency. Creating or attaching decisions remains agent-facing and is not a
prerequisite for reading an existing log in context.
