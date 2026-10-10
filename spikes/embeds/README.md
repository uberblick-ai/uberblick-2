# Embeds spike

Throwaway spike for a general embed block in documents, with Figma first and
YouTube and Loom as the second and third providers. Never merged. It answers
whether variant A from the Figma block proposal (a live iframe in the block
frame, inert until clicked) works, and what the shared embed frame needs.

## Questions

1. Do public Figma links embed from a `127.0.0.1` origin with the proposed
   attributes (`sandbox`, `referrerpolicy`, `allow`, `embed-host=uberblick`,
   `footer=false`, `theme`)? Which link kinds work: design frame, prototype,
   FigJam board, community file (and which of the two candidate forms)?
2. Does the same frame work for YouTube (`youtube-nocookie.com`) and Loom? Does
   YouTube need a referrer?
3. Does the sandbox break anything compared with no sandbox?
4. Is the frame inert until clicked (wheel scrolls the page), does a click
   activate it, does Escape reach Uberblick while Figma has focus (expected:
   no), and does a click outside release it?
5. Does `loading="lazy"` hold off the request inside a nested scroll container
   like `.ub-document-pane`?
6. Does the CSP `frame-src` allowlist let providers load and block anything
   else?
7. What does a broken Figma link look like, and does the iframe still fire
   `load`?
8. In the real editor: does a node view keep the same iframe (no reload) while
   people type in other blocks, a second client edits, the block moves, undo
   runs or the theme changes? What does the current web app need from a CSP
   (report-only violations)?

## Phase 1: harness (automated)

    node spikes/embeds/serve.mjs     # http://127.0.0.1:4599/ with the CSP
    node spikes/embeds/run.mjs       # Chromium, WebKit, Firefox via Playwright

`samples.json` holds public sample links. Fill the empty ones first.
`run.mjs` writes `results/summary.md`, `results/results.json` and screenshots
per browser.

## Phase 2: in the editor (manual code, throwaway)

Make code blocks whose language is `embed` render their single-line URL as the
embed frame (node view modelled on `chartBlockView` in
`packages/web/src/editor/chart.ts`; reuse `providers.js`). No schema, Markdown
or MCP changes. Run the app, seed a document with prose and two embed blocks,
and count iframe `load` events across: typing in a neighbouring paragraph, a
second browser context editing, moving the block, undo, and switching theme.
Add a report-only CSP to the `ub open` static server
(`packages/cli/src/open.ts`) and list the violations the current app raises.

## Out of scope

Schema type, `:::figma` Markdown, MCP tools, design polish, private Figma files
(needs a signed-in browser; a short manual check afterwards).
