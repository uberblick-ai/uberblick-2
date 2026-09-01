# The slash menu turns an empty paragraph into a Heading 2

Scenario: slash-menu-heading
Test: e2e/block-menu.spec.ts › typing / on an empty block filters, and Enter converts it

A throwaway prototype for #628. This file is the human half of one behavior;
the `Test:` line above is its only link to the machine half, and
`packages/web/test/scenario-link.test.ts` is the only thing that checks the link
still resolves. Nothing here is executed: the Playwright test is the assertion,
this page is the claim a person makes about the product.

## What a writer should be able to do

1. Open a document that already has one paragraph, with the caret in it.
2. Press Enter, which leaves a second paragraph, empty, below the first.
3. Type `/he`.
4. See the block menu offer exactly the three heading levels.
5. Press ArrowDown once, then Enter, to take Heading 2.
6. See the menu close, the second block become a level-two heading, and that
   heading be **empty** — the `/he` was the gesture, not text.
7. Type `a heading`, and see it land in that same heading.

## Assumptions this rests on

- The slash menu converts only an *empty* paragraph — a non-empty one is not
  offered the gesture at all. That is current product truth, stated in
  *Using the web editor* (`8c00fba4-4c81-4eb4-9ce5-c4bbd9427efd`), and this
  scenario would be wrong the day that changed.
- `/he` filters the menu to the heading levels and nothing else, so the count in
  step 4 is three. A new block type whose name matches `he` would break the
  scenario without breaking the product.
- The evidence comes from `mise run e2e`, whose harness starts a throwaway hub
  and dev server on ephemeral ports. Everything on the recording is synthetic:
  no real workspace, no real document, nobody's prose.
- Chromium only, at Playwright's `Desktop Chrome` viewport. The scenario says
  nothing about other browsers, and no run of it is evidence about them.
