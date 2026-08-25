/**
 * Agent typing theater (#121).
 *
 * The contracts this defends, and nothing beyond them:
 *
 * 1. **The document is never the animation.** The new text is in the Y.Doc and
 *    in the editor the instant the update lands — including while the reader is
 *    still being shown the old text. What the animation moves is what has been
 *    *shown*, which is why the visible text is read out of the DOM here rather
 *    than out of the document: they are two different things, and the whole
 *    feature is the gap between them.
 * 2. **The reader wins.** A block their caret is in is not animated, and their
 *    keystrokes survive a remote edit to that block untouched.
 * 3. **A second edit replaces the first**, so a block plays once, to its final
 *    state.
 * 4. **`prefers-reduced-motion` is a real off-switch**, not a shorter animation.
 * 5. **The backlog is bounded and one take is not** — the ~5s bound falls on
 *    what is *pending*, and the per-edit cap of an earlier draft does not exist.
 *
 * Everything runs against a real Y.Doc with a second replica wired the way the
 * hub wires one, because "remote" is a property of the transaction that
 * delivered the change and no fixture can fake one. Time is injected rather
 * than waited on: the animation frame loop keeps running under jsdom, and a
 * test driving playback by hand would otherwise be racing the wall clock.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlock,
  editBlock,
  getBlocks,
  initDoc,
  setBlockType,
} from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import { trackChangedBlocks } from "../src/editor/changed-blocks.js";
import {
  BACKLOG_MS,
  CARET_CLASS,
  REMOVED_CLASS,
  STRIKE_MS,
  VEIL_CLASS,
  nextDueAt,
  spliceBetween,
  typeSchedule,
  typingTheaterPluginKey,
} from "../src/editor/typing-theater.js";
import { mountEditor, snapshotFragment } from "./helpers.js";

const PARAGRAPH = "The quick brown fox jumps.";

/** No jitter, so a schedule is exactly the base rate. */
const STEADY = (): number => 0.5;

interface Scene {
  local: Y.Doc;
  remote: Y.Doc;
  blocks: string[];
  editor: Editor;
  /** Move the injected clock on and let the plugin see it. */
  tick: (ms: number) => void;
  /** ...or move it to an exact reading, which is what the loop itself does. */
  tickTo: (at: number) => void;
  /**
   * Let real time pass with the plugin hearing nothing about it.
   *
   * This is what being idle *is*: the loop only runs while there is something
   * to draw, so between animations no tick reaches the plugin and its own clock
   * stops. Advancing the injected clock without dispatching reproduces that
   * exactly.
   */
  idle: (ms: number) => void;
  dispose: () => void;
}

function scene(
  options: {
    paragraphs?: string[];
    reducedMotion?: boolean;
  } = {},
): Scene {
  const paragraphs = options.paragraphs ?? [PARAGRAPH];
  const local = new Y.Doc();
  initDoc(local, { uuid: "typing-doc", title: "Typing" });
  const blocks = paragraphs.map((text) =>
    appendBlock(local, { type: "paragraph", text }),
  );

  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  remote.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
  local.on("update", (update: Uint8Array) => Y.applyUpdate(remote, update));

  const marks = trackChangedBlocks(local);

  let clock = 1_000;
  const { editor } = mountEditor(local, {
    changed: marks,
    typing: {
      random: STEADY,
      now: () => clock,
      reducedMotion: () => options.reducedMotion === true,
    },
  });
  // Started *after* the editor has rendered the document, which is the order
  // the app has: the tracker arms on the replica and the hub sync, and the
  // editor is bound well before either. Starting it earlier would let
  // y-prosemirror's first render — the whole document, arriving against an
  // empty placeholder — through as though somebody had typed it.
  marks.start();

  return {
    local,
    remote,
    blocks,
    editor,
    tick: (ms) => {
      clock += ms;
      editor.view.dispatch(
        editor.state.tr.setMeta(typingTheaterPluginKey, { now: clock }),
      );
    },
    tickTo: (at) => {
      clock = at;
      editor.view.dispatch(
        editor.state.tr.setMeta(typingTheaterPluginKey, { now: clock }),
      );
    },
    idle: (ms) => {
      clock += ms;
    },
    dispose: () => editor.destroy(),
  };
}

let open: Scene | null = null;

afterEach(() => {
  open?.dispose();
  open = null;
});

function start(options?: Parameters<typeof scene>[0]): Scene {
  open = scene(options);
  return open;
}

/** What the theater state says it is doing. */
function theater(editor: Editor) {
  const state = typingTheaterPluginKey.getState(editor.state);
  if (state === undefined) throw new Error("the typing plugin is not installed");
  return state;
}

/**
 * The text a reader can actually see in a block: the document's own text minus
 * whatever the veil is hiding, plus the removed text the theater has drawn back
 * in. Read out of the DOM because that is the only place the two differ.
 */
function visibleText(blockId: string): string {
  const block = document.getElementById(blockId);
  if (block === null) throw new Error(`no block ${blockId} in the document`);
  let shown = "";
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      shown += node.nodeValue ?? "";
      return;
    }
    if (
      node instanceof HTMLElement &&
      node.classList.contains(VEIL_CLASS)
    ) {
      return;
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(block);
  return shown;
}

/** The block's text as the document holds it — the truth, not the show. */
function documentText(ydoc: Y.Doc, blockId: string): string {
  const block = getBlocks(ydoc).find((candidate) => candidate.id === blockId);
  if (block === undefined) throw new Error(`no block ${blockId}`);
  return block.text;
}

/**
 * Play the queue out to the end, the way the view's own loop would.
 *
 * One big jump of the clock is not the same thing: a take starts at whatever
 * "now" the tick carried, so a single leap finishes the take on screen and
 * starts the next one at zero elapsed. That is deliberate — it is what stops a
 * tab returning from the background replaying a minute of theater — so a test
 * that wants the queue drained has to step through it.
 */
function playOut(scene: Scene): void {
  for (let guard = 0; guard < 5_000; guard += 1) {
    const state = theater(scene.editor);
    const due = nextDueAt(state);
    if (due === null) return;
    scene.tickTo(Math.max(due, state.clock + 1));
  }
  throw new Error("playOut: the queue never drained");
}

/** Put the caret at the start of a block's text. */
function caretIn(editor: Editor, blockId: string): void {
  let start = 0;
  editor.state.doc.forEach((node, offset) => {
    if (node.attrs.id === blockId) start = offset;
  });
  editor.commands.setTextSelection(start + 1);
}

describe("the state is true the moment it arrives, however slowly it is shown", () => {
  it("holds the new text throughout an animation that is still showing the old", () => {
    const { local, remote, blocks, editor, tick } = start();
    const id = blocks[0]!;
    const rewritten = "The quick red fox leaps over the lazy dog.";

    editBlock(remote, id, PARAGRAPH, rewritten);

    // Applied in full, at once — in the CRDT and in the editor alike.
    expect(documentText(local, id)).toBe(rewritten);
    expect(editor.state.doc.child(0).textContent).toBe(rewritten);
    // And yet the reader is still looking at the sentence that was there.
    expect(visibleText(id)).toBe(PARAGRAPH);

    // 300ms into the typing phase, at 400wpm with no jitter: ten characters of
    // "red fox leaps over the lazy dog" — the rate is the pacing, and this is
    // what it paces to.
    tick(STRIKE_MS + 300);
    expect(visibleText(id)).toBe("The quick red fox le.");
    // The text arrives behind a caret, which is what makes it read as somebody
    // typing rather than as text fading in.
    expect(document.querySelectorAll(`.${CARET_CLASS}`)).toHaveLength(1);
    // Mid-animation, and the document has not wavered.
    expect(documentText(local, id)).toBe(rewritten);
    expect(snapshotFragment(local)[0]?.text).toBe(rewritten);

    tick(10_000);
    expect(visibleText(id)).toBe(rewritten);
    expect(theater(editor).playing).toBeNull();
    expect(document.querySelectorAll(`.${VEIL_CLASS}`)).toHaveLength(0);
  });
});

describe("an edit is timed from when it arrives", () => {
  /**
   * The theater's clock only advances when the loop ticks, and the loop only
   * runs while there is something to draw. So between animations the plugin's
   * clock stands still, and however long the reader sits reading, that is how
   * far behind it falls.
   *
   * A take stamped with that stale reading is born already expired: the next
   * tick carries the real time, measures the whole idle period as elapsed, and
   * finishes a take that lasts a fraction of a second before one character of
   * it has been drawn. The quieter the session, the more certainly the next
   * edit is silent — and a short edit is exactly the kind this is worst for.
   */
  it("animates a short edit that lands after a long quiet spell", () => {
    const scene = start({ paragraphs: ["seed"] });
    const { local, remote, blocks, editor, idle, tick } = scene;
    const id = blocks[0]!;

    // Nobody touches anything for five seconds. No ticks, so nothing tells the
    // plugin — which is the whole point.
    idle(5_000);

    // Then a short edit: four characters, about 120ms of typing.
    editBlock(remote, id, "seed", "seed one");

    // The loop's first wake-up carries the real clock. A take timed from when
    // it arrived is barely started; one timed from the last tick is five
    // seconds past its own end.
    tick(0);

    expect(theater(editor).playing?.take.id).toBe(id);
    expect(visibleText(id)).not.toBe(documentText(local, id));

    // ...and it still finishes normally.
    playOut(scene);
    expect(visibleText(id)).toBe("seed one");
    expect(documentText(local, id)).toBe("seed one");
  });
});

describe("the editor is bound before the document arrives", () => {
  /**
   * The load order the app actually has, which every other test in this file
   * skips by seeding the fragment first.
   *
   * A real editor binds to an empty room and renders ProseMirror's own
   * placeholder paragraph, and `BlockIds` then appends a local transaction to
   * give that placeholder an id. Anything that reads a local document change as
   * "the reader is working in here" is fooled by that one transaction, claims
   * the block the default selection sits in — the first — and silently animates
   * nothing ever again. Every other test here passed while that was true.
   */
  it("still animates the first block once the document turns up", () => {
    const local = new Y.Doc();
    const marks = trackChangedBlocks(local);
    // The clock never moves here: this test is about whether the take is ever
    // built at all, which is settled the moment the edit arrives.
    const { editor } = mountEditor(local, {
      changed: marks,
      typing: {
        random: STEADY,
        now: () => 1_000,
        reducedMotion: () => false,
      },
    });
    open = {
      local,
      remote: local,
      blocks: [],
      editor,
      tick: () => {},
      tickTo: () => {},
      idle: () => {},
      dispose: () => editor.destroy(),
    };

    // The placeholder has been rendered and given an id by now. The document
    // then arrives — hydration, so the tracker is still deaf for it — and only
    // then is edited.
    const source = new Y.Doc();
    initDoc(source, { uuid: "late-doc", title: "Late" });
    const id = appendBlock(source, { type: "paragraph", text: PARAGRAPH });
    Y.applyUpdate(local, Y.encodeStateAsUpdate(source));
    source.on("update", (update: Uint8Array) => Y.applyUpdate(local, update));
    marks.start();

    editBlock(source, id, PARAGRAPH, "The quick red fox jumps.");

    expect(theater(editor).playing?.take.id).toBe(id);
    expect(visibleText(id)).toBe(PARAGRAPH);
    expect(documentText(local, id)).toBe("The quick red fox jumps.");
  });
});

describe("the reader wins", () => {
  it("never animates the block their caret is in, and loses none of their typing", () => {
    const { local, remote, blocks, editor } = start();
    const id = blocks[0]!;

    caretIn(editor, id);
    editor.commands.insertContent("ABC");
    expect(documentText(local, id)).toBe(`ABC${PARAGRAPH}`);

    // An agent rewrites the very block being typed in.
    editBlock(remote, id, `ABC${PARAGRAPH}`, "ABCThe quick red fox jumps.");

    // Asserted here, before another keystroke: the edit was never queued at
    // all. Later in this test the reader's own typing would invalidate a take
    // anyway, which would leave these same assertions true for a reason that
    // has nothing to do with the rule being tested.
    expect(theater(editor).playing).toBeNull();
    expect(theater(editor).queue).toHaveLength(0);
    expect(document.querySelectorAll(`.${VEIL_CLASS}`)).toHaveLength(0);
    expect(visibleText(id)).toBe(documentText(local, id));

    // ...and the reader keeps typing straight through it.
    editor.commands.insertContent("DEF");

    // Every keystroke survived, the agent's edit merged, and the document and
    // the editor agree about all of it.
    const text = documentText(local, id);
    expect(text).toContain("ABC");
    expect(text).toContain("DEF");
    expect(text).toContain("red fox");
    expect(text).not.toContain("brown");
    expect(editor.state.doc.child(0).textContent).toBe(text);
    expect(snapshotFragment(local)[0]?.text).toBe(text);
    expect(visibleText(id)).toBe(text);
  });

  it("counts arriving in the editor at all, not only moving the caret", () => {
    const { local, remote, blocks, editor } = start();
    const id = blocks[0]!;

    // Focus without a selection change: tabbing in, a programmatic `focus()`,
    // or a click that lands exactly where the selection already was. The caret
    // is real and it is in block one — where ProseMirror's default selection
    // sits — so nothing may be hidden underneath it.
    editor.view.dom.dispatchEvent(new FocusEvent("focus"));

    editBlock(remote, id, PARAGRAPH, "The quick red fox jumps.");

    expect(theater(editor).playing).toBeNull();
    expect(theater(editor).queue).toHaveLength(0);
    expect(document.querySelectorAll(`.${VEIL_CLASS}`)).toHaveLength(0);
    expect(visibleText(id)).toBe(documentText(local, id));
  });

  it("fast-forwards a block that is mid-animation when the reader clicks into it", () => {
    const { local, remote, blocks, editor, tick } = start();
    const id = blocks[0]!;

    editBlock(remote, id, PARAGRAPH, "A brand new sentence entirely.");
    tick(STRIKE_MS + 60);
    expect(visibleText(id)).not.toBe(documentText(local, id));

    caretIn(editor, id);

    expect(theater(editor).playing).toBeNull();
    expect(visibleText(id)).toBe(documentText(local, id));
  });
});

describe("a second edit replaces the first", () => {
  /** Three blocks, so the second and third are queued behind a playing first. */
  function queued(): Scene {
    const scene = start({ paragraphs: ["alpha", "bravo", "charlie"] });
    scene.remote.transact(() => {
      editBlock(scene.remote, scene.blocks[0]!, "alpha", "alpha one");
      editBlock(scene.remote, scene.blocks[1]!, "bravo", "bravo two");
      editBlock(scene.remote, scene.blocks[2]!, "charlie", "charlie three");
    });
    return scene;
  }

  it("keeps a queued block's turn, and never shows the state it skipped", () => {
    const scene = queued();
    const { remote, blocks, editor } = scene;
    const [a, b, c] = blocks as [string, string, string];

    expect(theater(editor).playing?.take.id).toBe(a);
    expect(theater(editor).queue.map((take) => take.id)).toEqual([b, c]);
    // B is waiting, so it still looks like itself.
    expect(visibleText(b)).toBe("bravo");

    // A second edit to B, which is queued rather than playing.
    editBlock(remote, b, "bravo two", "bravo final");

    // Its place in the queue is its own — the reader is not made to watch the
    // page rewritten out of order.
    expect(theater(editor).queue.map((take) => take.id)).toEqual([b, c]);
    // ...and it still shows the text it started from. "bravo two" is the state
    // the first edit produced: queued, never played, and so never seen. Showing
    // it now — or striking it through when B's turn comes — would be inventing
    // a moment that never happened.
    expect(visibleText(b)).toBe("bravo");

    // When its turn does come it plays once, straight to the final text.
    playOut(scene);
    expect(visibleText(b)).toBe("bravo final");
    expect(documentText(scene.local, b)).toBe("bravo final");
  });

  it("plays the block once, to its final state", () => {
    const { local, remote, blocks, editor, tick } = start();
    const id = blocks[0]!;

    editBlock(remote, id, PARAGRAPH, "First rewrite.");
    tick(STRIKE_MS + 60);
    expect(theater(editor).playing?.take.text).toBe("First rewrite.");

    editBlock(remote, id, "First rewrite.", "Second rewrite.");

    // One take for the block, not two queued behind each other.
    expect(theater(editor).queue).toHaveLength(0);
    expect(theater(editor).playing?.take.text).toBe("Second rewrite.");

    tick(10_000);
    expect(visibleText(id)).toBe("Second rewrite.");
    expect(documentText(local, id)).toBe("Second rewrite.");
  });
});

describe("a block that stops being prose stops animating", () => {
  it("drops the take when a re-type turns the paragraph into source", () => {
    const { local, remote, blocks, editor, tick } = start();
    const id = blocks[0]!;

    editBlock(remote, id, PARAGRAPH, "The quick red fox jumps.");
    tick(STRIKE_MS + 60);
    expect(theater(editor).playing?.take.id).toBe(id);

    // `setBlockType` keeps the block id *and* replays the text delta, by
    // design — so an id-and-text check alone would find nothing wrong here and
    // go on veiling the tail of a code block. Driven from the remote replica so
    // the local selection is not involved: the reader-wins rule would otherwise
    // stop the animation for an entirely different reason.
    setBlockType(remote, id, "code", { language: "ts" });

    expect(theater(editor).playing).toBeNull();
    expect(theater(editor).queue).toHaveLength(0);
    // Nothing of the theater is left on the block. Its visible text is not
    // compared here: a `code` block renders through a NodeView that adds chrome
    // of its own (source-chrome.ts), and that chrome is not document text.
    expect(document.querySelectorAll(`.${VEIL_CLASS}`)).toHaveLength(0);
    expect(document.querySelectorAll(`.${REMOVED_CLASS}`)).toHaveLength(0);
    expect(documentText(local, id)).toBe("The quick red fox jumps.");
  });
});

describe("prefers-reduced-motion is an off-switch, not a shorter animation", () => {
  it("shows the new text at once and queues nothing", () => {
    const { local, remote, blocks, editor } = start({ reducedMotion: true });
    const id = blocks[0]!;

    editBlock(remote, id, PARAGRAPH, "Rewritten with no ceremony.");

    expect(visibleText(id)).toBe("Rewritten with no ceremony.");
    expect(documentText(local, id)).toBe("Rewritten with no ceremony.");
    expect(theater(editor).playing).toBeNull();
    expect(theater(editor).queue).toHaveLength(0);
    expect(document.querySelectorAll(`.${VEIL_CLASS}`)).toHaveLength(0);
  });
});

describe("the backlog is bounded; one take is not", () => {
  it("fast-forwards the oldest pending edits and leaves the long one playing", () => {
    // Four paragraphs, each rewritten to something that takes many seconds to
    // type — so the pending pile is well past the bound while any single take
    // is too.
    const long = "word ".repeat(40).trim();
    const { local, remote, blocks, editor } = start({
      paragraphs: ["one", "two", "three", "four"],
    });

    // One remote transaction carrying all four, so they arrive together.
    remote.transact(() => {
      editBlock(remote, blocks[0]!, "one", `one ${long}`);
      editBlock(remote, blocks[1]!, "two", `two ${long}`);
      editBlock(remote, blocks[2]!, "three", `three ${long}`);
      editBlock(remote, blocks[3]!, "four", `four ${long}`);
    });

    const state = theater(editor);
    // The first is playing and is itself longer than the backlog bound: the
    // "~1.5s cap" of the earlier draft is superseded by rate pacing, and a long
    // edit is allowed to take the time it honestly takes.
    expect(state.playing?.take.id).toBe(blocks[0]!);
    expect(state.playing?.take.duration).toBeGreaterThan(BACKLOG_MS);
    // Only the newest still animates; the ones in between were fast-forwarded.
    expect(state.queue.map((take) => take.id)).toEqual([blocks[3]!]);
    expect([...state.pulses.keys()]).toEqual([blocks[1]!, blocks[2]!]);

    // Fast-forwarded means shown, not skipped.
    expect(visibleText(blocks[1]!)).toBe(documentText(local, blocks[1]!));
    expect(visibleText(blocks[2]!)).toBe(documentText(local, blocks[2]!));
    // ...and waiting means still looking like its old self.
    expect(visibleText(blocks[3]!)).toBe("four");
  });
});

describe("the redraw costs what it draws", () => {
  /**
   * The animation is not a frame loop, and this is the difference that makes.
   *
   * Every redraw is a dispatched transaction: it rebuilds this plugin's
   * decorations and it wakes every other transaction listener in the editor.
   * Doing that at 60Hz for the whole of an uncapped animation would be a great
   * deal of work to show, on average, half a character — so the loop asks when
   * something next actually changes and sleeps until then.
   */
  it("wakes once per revealed character, not once per frame", () => {
    const { remote, blocks, editor, tickTo } = start({ paragraphs: ["seed"] });
    const id = blocks[0]!;
    const inserted = " and then some more";

    editBlock(remote, id, "seed", `seed${inserted}`);
    const take = theater(editor).playing?.take;
    expect(take?.inserted).toBe(inserted);

    // Drive the loop the way the view drives it: to the next due moment, and
    // never to an arbitrary frame boundary.
    let wakes = 0;
    for (let guard = 0; guard < 500; guard += 1) {
      const state = theater(editor);
      const due = nextDueAt(state);
      if (due === null) break;
      wakes += 1;
      tickTo(Math.max(due, state.clock + 1));
    }

    // One wake per character, and nothing else: this take has no strike phase
    // (a pure insertion) and no pulses. A frame loop over the same take would
    // have woken `duration / 16` times — roughly a hundred more.
    expect(wakes).toBe(inserted.length);
    const elapsed = take === undefined ? 0 : take.duration;
    expect(wakes).toBeLessThan(elapsed / 16);
    expect(visibleText(id)).toBe(`seed${inserted}`);
  });

  it("does not walk the document on a tick that changed nothing", () => {
    const { remote, blocks, editor, tick } = start();
    editBlock(remote, blocks[0]!, PARAGRAPH, "The quick red fox jumps.");

    const before = theater(editor).index;
    expect(before.size).toBeGreaterThan(0);

    tick(STRIKE_MS + 30);

    // The very same Map: a tick carries no steps, so every position in it still
    // stands and re-deriving it would be a full walk of the document for an
    // answer that cannot have changed.
    expect(theater(editor).index).toBe(before);
  });
});

describe("the splice a take is built from", () => {
  it("keeps the common prefix and suffix out of the change", () => {
    expect(spliceBetween("The quick brown fox.", "The quick red fox.")).toEqual({
      at: 10,
      removed: "brown",
      inserted: "red",
    });
  });

  it("reports an append as an insertion at the end, not an overlap", () => {
    expect(spliceBetween("aa", "aaa")).toEqual({
      at: 2,
      removed: "",
      inserted: "a",
    });
  });

  it("has nothing to say about text that did not change", () => {
    expect(spliceBetween("same", "same")).toBeNull();
  });

  it("never peels half an emoji off a shared surrogate", () => {
    // 😀 and 😃 are D83D DE00 and D83D DE03: the same high surrogate, so a scan
    // over code units keeps it as "unchanged" and leaves both sides holding
    // half a character — which renders as a replacement glyph, in the veil and
    // in the removed-text widget alike.
    const splice = spliceBetween("hi 😀 there", "hi 😃 there");
    expect(splice).toEqual({ at: 3, removed: "😀", inserted: "😃" });
    // The whole character on each side, not a stray surrogate.
    expect([...(splice?.removed ?? "")]).toHaveLength(1);
    expect([...(splice?.inserted ?? "")]).toHaveLength(1);
  });
});

describe("the typing schedule", () => {
  it("paces at the configured reading rate", () => {
    const times = typeSchedule("abcdefghij", STEADY);
    // Ten characters at 400wpm — two words of five — is 300ms.
    expect(times[9]).toBeCloseTo(300, 5);
  });

  it("takes a longer beat after a sentence than after a clause", () => {
    const sentence = typeSchedule("a.b", STEADY);
    const clause = typeSchedule("a,b", STEADY);
    const plain = typeSchedule("axb", STEADY);
    const gap = (times: number[]): number => times[2]! - times[1]!;
    expect(gap(sentence)).toBeGreaterThan(gap(clause));
    expect(gap(clause)).toBeGreaterThan(gap(plain));
  });

  it("reveals both halves of a surrogate pair at once", () => {
    const times = typeSchedule("a😀b", STEADY);
    expect(times).toHaveLength(4);
    // The emoji is two code units and one keystroke: never half an emoji.
    expect(times[1]).toBe(times[2]);
  });
});
