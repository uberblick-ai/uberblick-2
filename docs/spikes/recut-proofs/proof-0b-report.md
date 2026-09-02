# Proof 0b — root cause of the Proof 0 "content wipe"

**Verdict: there is no web-editor data-loss bug. The wipe is a test-harness
artifact.** The driver's third `caretToEnd()` click lands inside ProseMirror's
own 500 ms / 10 px multi-click window and is classified as a **triple click**,
which selects the whole textblock; the next keystroke then legitimately replaces
the selected block text, and y-prosemirror syncs that edit faithfully as
"delete every span, insert the typed character". The hub stop is not on the
trigger path at all — it merely sat between the driver's second and third click
in every scripted run, because the harness executes those steps ~200 ms apart.
The same three-click cadence is in the merged #704 spike driver, so the #704
"hard stop" is the same artifact. Proof 0's STOP verdict rests on a bug that
does not exist; its remaining reason is moot (§8).

Run locally as throwaway work in a fresh worktree at `9451ad4` and a second one
at `origin/main` (`e55eb5d`), macOS arm64, Node v26.7.0, y-prosemirror 1.3.7,
prosemirror-view 1.42.2, yjs 13.6.32, @hocuspocus 4.6.0, Playwright 1.62.1
(headless Chromium). Nothing committed, pushed, or written to the live corpus,
the real hub, its config, or `~/.local/share/uberblick`; both worktrees were
removed afterwards (§9).

---

## 1. Root cause, named

Three pieces of code, none of them wrong on its own:

**(a) The driver re-clicks the same point three times within 500 ms.**
`packages/web/e2e/proof0-control.ts` (Proof 0 driver, worktree-only):

- `caretToEnd()` lines 518–523: `page.mouse.click(box.x + box.width - 1,
  box.y + box.height / 2)` — the block's `<p>` spans the column, so the
  coordinate is identical every time (`x=1164` in every run).
- Call sites: line 683 (before typing `-web`), line 737/746 (before
  `-offline-web`), line 786 (before `-hub-down`).
- Measured gaps (§2): click #1 → #2 ≈ 130–215 ms, click #2 → #3 ≈ 170–275 ms,
  in all six Proof 0 runs and every run here. Playwright sends each click with
  native `detail: 1`, so the browser itself does no word/paragraph selection.

The merged spike driver has the identical helper and cadence:
`packages/web/e2e/daemon-authority-spike.ts` at `9451ad4`, `caretToEnd` lines
426–431, clicks at lines 580, 643 and 704 (the last immediately before
`page.keyboard.type("-hub-down")` on line 705).

**(b) ProseMirror counts clicks itself, ignoring the event's native count.**
`prosemirror-view@1.42.2/dist/index.js`:

- `handlers.mousedown`, lines 3339–3366. Lines 3343–3351:
  `if (now - view.input.lastClick.time < 500 && isNear(event,
  view.input.lastClick) && … ) { singleClick → doubleClick → tripleClick }` and
  `view.input.lastClick = { time: now, x, y, type, button }`.
- `isNear`, lines 3234–3237: `dx*dx + dy*dy < 100` (10 px).
- Line 3360: a double or triple click is routed to `handleDoubleClick` /
  `handleTripleClick` (3300–3308). Our editor registers no `handleTripleClick`
  prop (`packages/web/src/editor/*` — none), so `defaultTripleClick`
  (3309–3318) runs `selectionForTripleClick` (3319–3333), which for a
  textblock returns `TextSelection.create(doc, nodePos + 1, nodePos + 1 +
  node.content.size)` — the whole paragraph content, `{from: 1, to: 40}` in the
  traces — and dispatches it with origin `"pointer"`.

**(c) y-prosemirror syncs the resulting edit exactly.**
The keystroke replaces the selection: ProseMirror transaction
`replace {from:1, to:40, slice:"-"}` (observed, §2). Then, in
`y-prosemirror@1.3.7/src/plugins/sync-plugin.js` (the ESM `src/` is what Vite
bundles — `package.json` `exports["."].import`):

- plugin view `update()`, lines 216–233 → `binding.mux(() =>
  doc.transact(() => binding._prosemirrorChanged(view.state.doc),
  ySyncPluginKey))`;
- `_prosemirrorChanged`, lines 648–656 → `updateYFragment` (1145–1298), text
  branch lines 1214–1218 → `updateYText`, lines 1075–1091:
  `simpleDiff(str, next)` (1082–1085) with `str =
  "agent-middle-web-alpha-beta-offline-web"` and `next = "-"` → `{index: 0,
  remove: 39, insert: "-"}`; `ytext.delete(0, 39)` (1086) and
  `ytext.insert(0, "-")` (1087) inside one Yjs transaction with origin
  `ySyncPluginKey`.

That transaction is the "destructive update" of Proof 0 §1: a delete-set over
every author's spans plus one inserted character, authored by the browser,
valid, and correctly propagated. It is what any editor does when a user
selects a paragraph and types.

**What is *not* involved** (each excluded by direct observation, §2 and §9):
no editor rebind (`binding.bind`/`sync.initView`/`sync.forceRerender` occur
exactly once per run, at page load), no `_typeChanged` mux skip of a remote
change (the 25 skips per run are the local echoes of the 25 local keystroke
transactions), no `createNodeFromYElement`/`createTextNodesFromYText` catch
path, no snapshot/restore, no app code that rewrites content (grep of
`packages/web/src` for `setContent|clearContent|insertContent|deleteRange|
_forceRerender|ySyncPluginKey|snapshot|dispatch(` finds only the composer,
block menu, retype, table/mermaid source views, input rules and mention menu —
none fired), and nothing in `collab/rooms.ts` or the Hocuspocus provider
touches the Y.Doc on close (`provider.onClose()`,
`hocuspocus-provider.esm.js` 889–899, resets `synced`/`isAuthenticated`,
clears pending sends and removes *remote awareness states* only).

## 2. Event chain — hub stop to the destructive transaction

Instrumented spike-worktree run `proof0b/runs/scenarios/control-run-QGTgjf`
(all three clicks logged; browser clock, one document `<p>` at `x=1164`):

| time (ms) | source | event |
| --- | --- | --- |
| …165156 | driver click #1 (before `-web`) | PM `mousedown`: `lastClick` was empty → **singleClick**; caret at end |
| …165331 | driver click #2 (+175 ms, before `-offline-web`) | `now − lastClick.time = 175 < 500`, `isNear` → **doubleClick**; no handler, caret stays collapsed at end (`sel {22,22}`) |
| …165501 | driver `hub.stop()` | hub sends per-room CLOSE (`server.ts` 721 `closeConnections()`), then the 1001 frame (`closeSockets`, 736) |
| …165502–165507 | browser (`collab/rooms.ts`) | `provider.close` (1000 "Reset Connection", then 1001 "hub shutting down") → `dropSocket()` (538–545, 220–250) → `socket.disconnect` → redial → `ERR_CONNECTION_REFUSED`; awareness `removed=[Beta]`; one `yjs-cursor$` transaction, **doc unchanged**, `sel {40,40}` |
| …165528 | driver | step 11: status word reads `offline`; PM doc and DOM both `"agent-middle-web-alpha-beta-offline-web"`, `sel {40,40}`, editor focused, not destroyed |
| …165530 | driver click #3 (+199 ms after click #2, same `x`, `y` within 5 px) | `mousedown.before`: `lastClick.type = doubleClick`, 199 ms old → PM classifies **tripleClick** (`mousedown.after`: `lastClick.type: "tripleClick"`) |
| …165531 | ProseMirror | `defaultTripleClick` → pointer transaction `sel {from: 1, to: 40}` — the whole block selected; **docChanged = false** |
| …165537 | first keystroke `-` | PM transaction `replace {from:1, to:40, slice:[text "-"]}`; PM doc → `"-"` |
| same tick | y-prosemirror | `sync.update entered=true` → `_prosemirrorChanged` → `updateYText: str="agent-middle-web-alpha-beta-offline-web" next="-" index=0 remove=39 insert="-"` (observed in `proof0b/runs/final/control-run-2gdeQr` and the origin/main run) |
| same tick | Y.Doc `update` (browser, origin `PluginKey`, local) | `structs={browser: ["16:\"-\""]}`, `deletes={browser: 0+16, Beta: 0+11, creator: 7+6, 14+6}` — Proof 0's exact signature |
| …165540–165620 | keystrokes `hub-down` | plain inserts at 2, 3, … 9 |

Same shape, same classification, in every losing run listed in §3 and §4.

**Why the "network pause" in Proof 0 did not wipe:** click ordinal, not
transport. In Proof 0's flow the pause preceded click #2, which PM classified
as a *double* click — for which our editor has no handler, so the caret stayed
collapsed and `-offline-web` appended. The wipe needs the *third* click, and
in Proof 0 the third click happened to come after the hub stop. Put the third
click inside a pause (§3 `pause-3clicks`), or stop nothing at all
(`none-3clicks`), and the wipe reproduces; put it 600 ms after a real hub stop
and it does not.

## 3. Minimal trigger and the prediction tests

**Minimal condition:** a `mousedown` on the block within 500 ms and 10 px of a
previous `mousedown` that was itself within 500 ms and 10 px of an earlier one
(three clicks, same spot, < 500 ms apart pairwise, no modifier), followed by
typing. Nothing about authorship, the hub, the socket, IndexedDB, awareness,
or the daemon is required.

Predictions were written down before running (driver flags in
`proof0b/instrumentation/make-driver.py`; results in
`proof0b/runs/scenarios/`):

| scenario | change from the Proof 0 control | predicted | observed | PM's verdict on the decisive click | click #2→#3 gap |
| --- | --- | --- | --- | --- | --- |
| `stop-default` | none (hub stop) | loss | **loss** | tripleClick | 199 ms |
| `stop-settle600` | wait 600 ms before click #3 | no loss | **no loss** | singleClick | 816 ms |
| `stop-noclick` | hub stop, no click #3 | no loss | **no loss** | (2 clicks) doubleClick | — |
| `stop-agents-only` | multi-author block (creator+Alpha+Beta), the browser's only click is the post-stop one | no loss | **no loss** | singleClick | — |
| `stop-web-only` | creator + browser only, three quick clicks | loss | **loss** | tripleClick | 188 ms |
| `pause-3clicks` | `context.setOffline(true)` instead of a stop | loss | **loss** | tripleClick | 275 ms |
| `none-3clicks` | no outage at all, hub up throughout | loss | **loss** | tripleClick | 169 ms |

7/7 predictions held. "Multi-author" and "hub stopped" — Proof 0 §2's stated
joint conditions — are both falsified as conditions: `stop-agents-only` has
both and no loss; `none-3clicks` has neither and loses.

## 4. origin/main

`git log 9451ad4..origin/main -- packages/web/src/collab packages/web/src/editor
packages/web/src/ui/EditorPane.tsx` lists `360223e` (#718) and `7e6be05`
(#717). `collab/rooms.ts` and `editor/*` are byte-identical (the instrumentation
patcher's exact anchors applied cleanly at `e55eb5d`); the `EditorPane.tsx`
diff is status-line chrome and a threads toggle, `BoundEditor` and its binding
effect are unchanged; `hooks.ts` changed one comment; `config.ts` one comment.
Same y-prosemirror/prosemirror-view builds.

Confirmed by running the same driver against a second worktree at
`origin/main` (`proof0b/runs/final/`): `main-stop-default` **loses**
(tripleClick, `updateYText remove=39 insert="-"`), `main-stop-settle600` keeps
everything (singleClick), `main-fix-keyboard` keeps everything. Identical.

## 5. Candidate fix

**No production change is warranted.** ProseMirror's triple-click-selects-
block and y-prosemirror's faithful sync are correct; overriding
`handleTripleClick` in the editor would remove a standard editing gesture to
appease a script. The fix belongs to the drivers: never place the caret by
re-clicking the same point inside PM's multi-click window. The candidate,
implemented in the throwaway driver `proof0b-control.ts` (generated by
`make-driver.py`, flag `PROOF0B_CARET`), is:

```ts
    // The candidate harness fix. A mouse click is classified by ProseMirror
    // against its own `input.lastClick` (<500 ms, <10 px => double, then
    // triple), independent of the event's native click count, and a triple
    // click selects the whole textblock. Placing the caret by keyboard when
    // the editor already has focus never enters that heuristic; waiting out
    // the window keeps a click a single click.
    if (!noClick) {
      if (caret === "keyboard") {
        // `globalThis.document`: this file has a local `document` (the created doc), which esbuild renames inside the serialised arrow.
        const focused = await page.evaluate(() => globalThis.document.activeElement?.closest(".ProseMirror") != null);
        if (focused) await page.keyboard.press("End");
        else await caretToEnd(page);
        trace("12a-caret-strategy", { caret, focused });
      } else if (caret === "wait") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 550));
        await caretToEnd(page);
        trace("12a-caret-strategy", { caret });
      } else {
        await caretToEnd(page);
      }
    }
```

For the merged spike driver the equivalent one-line change is: in
`packages/web/e2e/daemon-authority-spike.ts` replace the click on line 704 with
`await page.keyboard.press("End")` (the editor is already focused there), or
make `caretToEnd` wait out the window when `Date.now()` is within 500 ms of its
previous click.

**Results with the fix, all with a real hub stop on the same multi-author
block** (`proof0b/runs/fix/`, `proof0b/runs/final/`): `keyboard` ×3 at
`9451ad4` and ×1 at `origin/main`, `wait` ×1 — **5/5 clean**: web, MCP, hub and
a fresh `ub mcp serve` all read
`agent-middle-web-alpha-beta-offline-web-hub-down` after the restart. (The
first three `keyboard` attempts failed before running for a driver typo —
esbuild renamed the global `document` inside the serialised `page.evaluate`
because the driver has a local `document`; fixed as shown above. The
`stop-settle600` and `stop-noclick` negatives in §3 are two more clean hub-stop
runs without the fix.)

**Tests:** no file under `packages/web/src` or any package changes for this
fix, so there is nothing for `mise run test` to defend; the instrumentation
edits were throwaway and went with the worktrees. Reproductions of the wipe
with the unfixed gesture in this proof: 8/8 (baseline, instrumented,
`stop-default`, `stop-web-only`, `pause-3clicks`, `none-3clicks`, final spike,
final origin/main) — 14/14 counting Proof 0's six.

**Related exposure, not verified here:** the merged specs
`packages/web/e2e/agent-attribution.spec.ts:159`,
`block-menu.spec.ts:54` and `collab.spec.ts:134` use the same
`box.x + box.width - 1` click. Any of them that clicks the same spot three
times within 500 ms would select the block the same way; worth a one-line
audit when the harness helper is fixed.

## 6. What the eventual ticket's acceptance test should assert

The ticket is a harness/record ticket, not an editor ticket:

1. **Harness invariant.** After every scripted caret placement and before
   typing, `editor.state.selection.empty === true` in the page (a range
   selection is a failed placement, not a caret). The shared helper places the
   caret by `End`/`Home` when the editor is focused, and clicks only when it
   is not — or refuses to click within 500 ms of its own previous click.
2. **The Proof 0 control passes.** Multi-author block (creator + browser +
   two agents, including the offline concurrent edit), real `hub.stop()`,
   browser types, `createHub` on the same port: the block reads
   `<pre-outage text><typed text>` on the web page, on the surviving
   `ub mcp serve`, at the hub, on a fresh `ub mcp serve` that hydrates from
   the hub, and after a page reload — exactly `proof0b-control.ts` with
   `PROOF0B_CARET=keyboard`. Run it through `ub open` too when that exists.
3. **The gesture is documented, not "fixed".** A positive assertion that three
   clicks within 500 ms at one point select the whole block (`selection.from
   === blockStart + 1 && selection.to === blockEnd`), so a later reader does
   not add a `handleTripleClick` override to the editor to make a script
   green.

## 7. Consequences for the topology plan (v3)

- **`ub open` (v3 §5.3) is off the trigger path.** The trigger is a
  pointer-gesture classification inside the browser's ProseMirror view; it
  fires identically with the hub up (`none-3clicks`), paused, or stopped, and
  with the localhost link up or down. Keeping the browser's localhost link up
  during a remote outage neither causes nor prevents it. The `beforeSync`
  gate (§5.3) and the read-only-while-disconnected rule (§5.4) are irrelevant
  to it — a select-and-type is a legitimate edit that no layer should refuse.
- **Withdraw Proof 0 §7.1.** There is no phase-0 "web-editor content wipe"
  blocker to file as a P1 against the web client. What is owed instead is a
  small harness ticket (§6) and a record correction.
- **Correct the #704 record.** The #704 spike's hard stop — "disconnecting
  the upstream hub erased pre-outage content from the still-running local
  authority" — was produced by `daemon-authority-spike.ts` lines 580/643/704:
  the same three clicks ~200 ms apart, the third one a triple click. It is
  evidence about the driver, not about the daemon, the local authority, or the
  hub. Its *other* finding (the nondeterministic refused-append propagation,
  Proof 0 §4) is untouched by this and remains a daemon-specific mark.
- **Proof 0 §7.2 stands as a statement but no longer as a defence.**
  `beforeSync` guarantees replay-safety, not content preservation; that is
  still true and still worth stating in v3 §7/§11. But no content-loss
  defence is owed for this case, because the update was the user's edit.
- **The STOP verdict should be re-decided on the remaining evidence.** Reason
  1 (production bug) is withdrawn; reason 2 (v3 retains every ingredient of
  the mechanism) is moot because the mechanism is a gesture, not a topology
  property.

## 8. What Proof 0 got right and wrong

Right: the mechanism is a single browser-authored Yjs transaction that deletes
every author's spans and inserts the typed text; `repairDuplicateBlocks` and
block ids are uninvolved; IndexedDB is irrelevant; it is reproducible on the
production path. Wrong: the two "jointly-present conditions" (multi-author
text, hub actually gone) — both are coincidences of the scripted timeline —
and the inference from "pause appended correctly" to "the wipe needs the hub
to go away". Proof 0 §2 also said the view "diverges" from the document; it
never does — PM doc, DOM and Y.Doc agree at every step until the keystroke,
and then they agree again. What diverged was the *selection* from what the
driver assumed it had placed.

## 9. Instrumentation and artifacts

Everything under `<scratch>/proof0b/`:

- `instrumentation/apply-instrumentation.py` — anchored, idempotent patcher
  (keeps `*.p0orig`): y-prosemirror 1.3.7 `src/plugins/sync-plugin.js`
  (logs `update()` mux entry, `_prosemirrorChanged`, `updateYText` inputs +
  stack, `_typeChanged` incl. mux skips, `_forceRerender`, `initView`/
  `destroy`, both delete-on-error catches), `packages/web/src/editor/
  guarded-binding.ts` (every Tiptap transaction: steps, meta, PM/DOM block
  text, selection; `mousedown` native `detail` and PM `input.lastClick`
  before/after; bind/guard/destroy stacks; `window.__p0state()`), and
  `packages/web/src/collab/rooms.ts` (provider/socket events, `dropSocket`
  branches, decoded Y.Doc updates by client + delete set, awareness changes).
  The resulting diffs: `web-src-instrumentation.patch` (270 lines, also covers
  the `mise.toml` task) and
  `y-prosemirror-1.3.7-sync-plugin-instrumentation.patch` (185 lines). Note
  the first spike-worktree runs used Vite's stale pre-bundle of y-prosemirror
  (the dep cache was built by the un-instrumented baseline and is not
  invalidated by node_modules edits); the app-level and Y-level traces were
  unaffected, and the final runs (`runs/final/`) were made after clearing
  `packages/web/node_modules/.vite`, with `updateYText` observed directly.
- `instrumentation/make-driver.py` → `packages/web/e2e/proof0b-control.ts`
  (copy in `instrumentation/new-files/`), derived from Proof 0's
  `proof0-control.ts` with the helpers verbatim: captures `P0B` console lines
  into `trace.jsonl`, reads PM state per step, and takes `PROOF0B_AUTHORS`,
  `PROOF0B_OUTAGE=stop|pause|none`, `PROOF0B_SETTLE_MS`, `PROOF0B_NO_CLICK`,
  `PROOF0B_TYPE_TEXT`, `PROOF0B_CARET=click|keyboard|wait`. Task:
  `mise run proof0b-control` (appended to `mise.toml`).
- `analyze-p0b.py` — the browser-ordered timeline used in §2;
  `run-scenarios.sh`, `run-fix.sh`, `run-fix2.sh`, `run-final.sh`,
  `run-main.sh` — the batches.
- `runs/` — every kept run (`hub.sqlite`, `trace.jsonl`, `result.json`,
  per-agent dirs): `control-run-m1NSxM` (baseline, unmodified),
  `control-run-oES9ds` (first instrumented), `scenarios/` (§3),
  `fix/` (§5), `final/` (§4 and the direct `updateYText` observation),
  `main/` (origin/main attempts that crashed on an ASI hazard in my own
  instrumentation — `true(pluginState.doc)` — kept for honesty; fixed before
  `final/`).

Reproduce: recreate a worktree at `9451ad4` (Proof 0 §5), `mise trust && mise
run install`, apply Proof 0's `tracked-changes.patch` and copy its new files,
`python3 apply-instrumentation.py <worktree>`, `python3 make-driver.py
<worktree>`, append the task from `web-src-instrumentation.patch`, delete
`packages/web/node_modules/.vite`, then e.g.
`PROOF0_KEEP_DIR=<dir> PROOF0B_OUTAGE=none mise run proof0b-control` (loses)
and `… PROOF0B_CARET=keyboard mise run proof0b-control` (keeps).

**Both worktrees (`proof0b-worktree` at `9451ad4`, `proof0b-main-worktree` at
`e55eb5d`) were removed with `git worktree remove --force` and pruned after
the artifacts above were copied out.**
