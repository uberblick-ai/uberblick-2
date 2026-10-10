# Figma blocks

Part of Markdown. A Figma block shows a live view from Figma inside a document, so a reader sees the design where it is discussed: a frame, a whole file, a prototype, a FigJam board, slides or a community file. It is the first embed block. Later providers, such as YouTube or Loom, get their own container and share its frame and rules.

## Markdown

```markdown
:::figma
url: https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345
title: Payment, mobile
height: 560

Card form after the address step. Error states are on the [next frame](https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-401).
:::
```

| Key | Required | Rule |
| --- | --- | --- |
| url | yes | A figma.com link to a design file or frame, a prototype, a FigJam board, slides or a community file |
| title | no | One line. Defaults to Figma's title for the file, else the file name in the link |
| height | no | Pixels, 240 to 960, default 480. The width is always the column |

The header ends at the first blank line, like a card. The body is an optional one-paragraph caption with marks and links, and comments can anchor in it. Keys are lowercase and closed. On GitHub the block reads as a paragraph with the link still clickable.

Uberblick keeps only what identifies the view: the file key, the file name, `node-id`, `starting-point-node-id` and `version-id`. Everything else in a pasted link, such as Figma's `t=` share tracking, is dropped on save. Uberblick never stores a Figma token or password.

## Reading a page with embeds

```
Figma  Payment, mobile                      Expand   Open in Figma
┌───────────────────────────────────────────────────────────────┐
│                   (the frame, live from Figma)                │
│                        Click to interact                      │
└───────────────────────────────────────────────────────────────┘
Card form after the address step. Error states are on the next frame.
```

- The block has the shared block frame with the teal bar every embed block shares. The caption row shows "Figma", the title, and Expand and Open in Figma. On a phone the actions fold into one ↗ button and the height is capped at 70% of the screen.
- It stays still until clicked, so scrolling the page never pans the canvas. A click, or Enter on the focused block, hands the pointer and keyboard to Figma. Done in the caption row, or a click outside, gives them back. Escape cannot, because Figma holds the keyboard.
- A viewer loads only when its block comes near the screen. At most three Figma viewers are live at once, and a viewer that scrolls far away goes back to its placeholder.
- Before loading, the reader's browser asks Figma for the file's title and whether the link is public. The Uberblick server never contacts Figma.
- Figma's theme is set once when the viewer loads. A theme switch does not reload it.
- Moving the block reloads its viewer once, for the person who moved it.

## Scenarios

### An agent adds a design to a spec

`insert_block` with type `figma` takes the container body without the `:::` lines. `get_doc` returns the same body, plus fields derived from the link so agents don't parse URLs:

```json
{ "type": "figma",
  "text": "url: https://www.figma.com/design/k3Lm9QzT2x/Checkout-flow?node-id=12-345\ntitle: Payment, mobile\nheight: 560\n\nCard form after the address step. …",
  "figma": { "kind": "frame", "file": "k3Lm9QzT2x", "fileName": "Checkout flow", "node": "12:345" } }
```

An agent cannot see the frame, so the title and caption carry the meaning. With a Figma MCP server it can fetch the frame by file and node.

### Pasting a Figma link

A bare Figma link pasted on an empty line becomes a Figma block. Undo straight after turns it back into a link. A Figma link pasted inside a sentence stays a link. "Figma" in the block menu inserts an empty block with the link field focused.

### The file is private or deleted

Figma does not publish private or deleted files, so the block shows:

```
Figma  Checkout flow                                Open in Figma
  Figma can't show this file publicly. If you have access, load it to sign in.
  [Load]
```

Load opens Figma's viewer, which asks a reader with access to sign in.

### Offline or printing

The block shows its title, its caption and "The Figma preview needs a connection." Printing shows the title and the link.

### A link that is not Figma's

`insert_block` with type `figma` and a link that is not Figma's is refused: `figma blocks take figma.com links only; use a plain link for other sites`. On import, an invalid Figma block falls back to paragraphs, so its link survives as a plain link.

## Privacy and security

- Uberblick builds the viewer's address from the stored fields, never from the pasted text, with `embed-host=uberblick`, so Figma never learns the document, the workspace or the hub's address.
- The frame sends no referrer and runs sandboxed. The web app's Content-Security-Policy allows framing `embed.figma.com` and `www.figma.com` and no other site.

## Not in scope

- Other providers such as YouTube and Loom. The spike shows they fit the same frame, each with its own container.
- Snapshots or images of a frame, Figma API tokens, and Figma comments.
- Figma links shown as pills in text.

## Related

Card blocks, Markdown, Web UI: blocks. Evidence: the embeds spike on branch `claude/project-thread-oysyb3` (https://github.com/uberblick-ai/uberblick-2/blob/claude/project-thread-oysyb3/spikes/embeds/findings.md).
