/**
 * Agent typing theater: what a remote edit to a prose block *looks* like.
 *
 * ## The document is never the animation
 *
 * A remote update is applied by y-prosemirror in full, at once, the instant it
 * arrives — this file does not delay it, buffer it, or touch it. Everything
 * here is a {@link DecorationSet}: presentation drawn on top of state that is
 * already true. Read the document mid-animation, export it, hash a block's
 * `rev` — you get the new text, because the new text is what is in there. The
 * theater only decides which parts of it the reader has been shown yet.
 *
 * That is also why the animation is never made by slicing an edit into smaller
 * writes. A sliced `edit_block` would put the theater into the CRDT, replicate
 * it to every other client, and land in the update log — the exact opposite of
 * a render-layer effect.
 *
 * ## The shape of one take
 *
 * A remote edit to a prose block is reduced to a single splice: the common
 * prefix and suffix are peeled off, and what is left is "this much was removed
 * here, and this much was inserted in its place" (see {@link spliceBetween}).
 * A real diff library would find several such runs in one edit; one run is
 * enough, because a `edit_block` splice *is* one run, and a whole-paragraph
 * rewrite reads better as one sweep than as a scatter of word-sized ones. It
 * also keeps the package free of a diff dependency it would otherwise need.
 *
 * The take then plays in two phases:
 *
 * - **strike** (~{@link STRIKE_MS}) — the removed text, which is no longer in
 *   the document, is drawn back in as a widget: struck through, fading and
 *   shrinking away. Skipped entirely when nothing was removed.
 * - **type** — the inserted text, which *is* in the document, is hidden by an
 *   inline decoration whose end retreats character by character, with the agent
 *   caret riding the frontier. Paced by {@link TYPING_WPM} with jitter and a
 *   longer beat after sentence and clause endings, so it reads as somebody
 *   typing rather than a progress bar. There is no cap on one take's duration:
 *   a two-word fix is over in well under a second and a paragraph rewrite takes
 *   the honest few seconds it would take to type.
 *
 * A take that is *queued* rather than playing draws its old self: removed text
 * present and un-struck, inserted text still hidden. So a block waits looking
 * like it did before the edit, then plays, rather than showing the answer and
 * rewinding to ask the question.
 *
 * ## One actor, one queue
 *
 * Takes play one at a time, in arrival order, so a session that rewrites four
 * blocks reads as one writer moving down the page.
 *
 * The decided design is one queue *per agent session*, with sessions animating
 * concurrently and attributed through the `lastAction` awareness field. That
 * field does not exist yet (#73), so there is exactly one identifiable actor
 * here — "something remote" — and therefore exactly one queue. Two rules of the
 * decided design wait on the same attribution and are deliberately absent
 * rather than approximated:
 *
 * - concurrent playback for concurrent sessions, which needs a session to
 *   attribute a take to;
 * - flushing a queue when its agent disconnects, which needs to tell "the agent
 *   left" from "no agent ever published awareness". An MCP client writing
 *   through the hub need not publish awareness at all, so a rule keyed on the
 *   remote-peer count would cancel the animation on the *ordinary* case rather
 *   than the departing one. A queue that outlives its author is bounded by the
 *   backlog rule below in the meantime.
 *
 * Three rules keep the queue from becoming a backlog of theater:
 *
 * - **The backlog is bounded, one take is not.** While the *pending* takes add
 *   up to more than {@link BACKLOG_MS}, the oldest are dropped to their final
 *   state with a brief pulse. The newest survive, however long they are — the
 *   bound is on how much the reader is made to wait, not on how long an honest
 *   edit takes to draw.
 * - **A second edit to a block replaces the first**, so the block plays once,
 *   to its final state. See the validity check in `reduce`, which is where that
 *   falls out.
 * - **The reader wins.** A block the local caret or selection is in never
 *   animates, and touching a block that is waiting or playing fast-forwards it
 *   on the spot. Correctness over show: nothing is ever hidden underneath
 *   somebody's cursor.
 *
 * ## Why hydration is not an edit
 *
 * The IndexedDB replay and the hub's first sync arrive as remote transactions
 * carrying the whole document, and replaying *those* would type the document in
 * from scratch every time it was opened. The answer is not a second copy of the
 * arrival logic: it is {@link ChangedBlocks.recording}, the state #120 already
 * works out and already gates its own gutter marker on. Nothing animates until
 * the tracker says the document has arrived.
 *
 * ## Why the clock lives in the view
 *
 * `apply` is a pure function of the transaction it is given, so the passing of
 * time has to reach it as a transaction: the plugin's view runs an animation
 * frame loop for as long as anything is pending and dispatches an empty
 * transaction carrying `now`. This is the same redraw trick changed-marks.ts
 * uses for the clearing timer, and it is safe for the same reason — a timer
 * callback is nowhere near a Yjs observer, so there is no half-rendered
 * ProseMirror document for y-prosemirror to diff stale content back over.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Selection, Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "y-prosemirror";
import type { ChangedBlocks } from "./changed-blocks.js";

/** How fast the agent types, in words per minute. One constant, by decision. */
export const TYPING_WPM = 400;

/** The conventional word, for turning words per minute into characters. */
const CHARS_PER_WORD = 5;

const MS_PER_CHAR = 60_000 / (TYPING_WPM * CHARS_PER_WORD);

/** How long the removed text takes to strike through and collapse. */
export const STRIKE_MS = 350;

/**
 * How much *pending* playback one actor may have waiting. The take on screen is
 * not counted: it is being watched, not waited for.
 */
export const BACKLOG_MS = 5_000;

/** How long a fast-forwarded block pulses, so the change is not silent. */
export const PULSE_MS = 600;

/** How far either side of the base rate a keystroke may fall. */
const JITTER = 0.35;

/** The beat after a sentence ends, and after a clause does. */
const SENTENCE_PAUSE = 1.45;
const CLAUSE_PAUSE = 1.2;

const SENTENCE_END = new Set([".", "!", "?", "…"]);
const CLAUSE_END = new Set([",", ";", ":"]);

/**
 * The blocks that animate. `code` and `mermaid` are source text, not prose —
 * they update instantly and are announced by the #120 gutter marker instead.
 */
const PROSE_BLOCKS = new Set(["paragraph", "heading"]);

/** The removed text, drawn back in. */
export const REMOVED_CLASS = "ub-typed-out";
/** ...and the same, on its way out. */
export const REMOVED_GOING_CLASS = "ub-typed-out-going";
/** Inserted text the reader has not been shown yet. */
export const VEIL_CLASS = "ub-typing-veil";
/** The agent's typing caret. */
export const CARET_CLASS = "ub-typing-caret";
/** A block that was fast-forwarded rather than played. */
export const PULSE_CLASS = "ub-typed-pulse";

export const typingTheaterPluginKey = new PluginKey<TheaterState>(
  "uberblick/typing-theater",
);

/** One edit to one block, reduced to a single splice. */
export interface Splice {
  /** Where the change starts, as a character offset into the new text. */
  at: number;
  /** What was there. No longer in the document — the theater redraws it. */
  removed: string;
  /** What is there now, and is being revealed. */
  inserted: string;
}

/**
 * The one splice that turns `before` into `after`, or `null` if they are equal.
 *
 * Common prefix and suffix are peeled off and everything between them is the
 * change. The two scans are bounded so they cannot cross: `"aa" → "aaa"` peels
 * a prefix of two and then no suffix at all, which describes an insertion at
 * the end rather than a nonsensical overlapping one.
 */
export function spliceBetween(before: string, after: string): Splice | null {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);
  let at = 0;
  while (at < shorter && before[at] === after[at]) at += 1;
  let tail = 0;
  while (
    tail < shorter - at &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    at,
    removed: before.slice(at, before.length - tail),
    inserted: after.slice(at, after.length - tail),
  };
}

/**
 * When each character of `text` becomes visible, in milliseconds from the start
 * of the typing phase.
 *
 * Indexed by UTF-16 code unit, because that is what a ProseMirror position
 * counts — but stepped by code point, so the two halves of a surrogate pair
 * share one time and an emoji never appears as half of itself.
 */
export function typeSchedule(text: string, random: () => number): number[] {
  const times = new Array<number>(text.length);
  let elapsed = 0;
  let previous = "";
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index);
    if (code === undefined) break;
    const character = String.fromCodePoint(code);
    const jitter = 1 + (random() * 2 - 1) * JITTER;
    elapsed += MS_PER_CHAR * jitter * pauseAfter(previous);
    for (let unit = 0; unit < character.length; unit += 1) {
      times[index + unit] = elapsed;
    }
    previous = character;
    index += character.length;
  }
  return times;
}

/** How much longer the gap is because of the character just typed. */
function pauseAfter(previous: string): number {
  if (SENTENCE_END.has(previous)) return SENTENCE_PAUSE;
  if (CLAUSE_END.has(previous)) return CLAUSE_PAUSE;
  return 1;
}

/** How many characters are visible after `elapsed` milliseconds of typing. */
function revealedBy(times: readonly number[], elapsed: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? 0) <= elapsed) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** One block's edit, ready to play. */
interface Take extends Splice {
  /** The block, by the id every block carries. */
  id: string;
  /**
   * The block's whole text after the edit. Re-checked before drawing: if the
   * block no longer says this, the offsets in this take describe a document
   * that no longer exists and the take is abandoned rather than misdrawn.
   */
  text: string;
  /** {@link typeSchedule} for {@link Splice.inserted}. */
  times: readonly number[];
  /** Strike plus typing — how long this take occupies the queue. */
  duration: number;
}

interface Playing {
  take: Take;
  startedAt: number;
}

interface TheaterState {
  playing: Playing | null;
  queue: readonly Take[];
  /** Fast-forwarded blocks, each with the time its pulse ends. */
  pulses: ReadonlyMap<string, number>;
  /**
   * Whether the reader has ever put a caret in this editor. Until they have,
   * `state.selection` is ProseMirror's default — the very top of the document —
   * which is nobody's cursor and must not veto the first block's animation.
   */
  engaged: boolean;
  clock: number;
  decorations: DecorationSet;
}

function idleState(now: number): TheaterState {
  return {
    playing: null,
    queue: [],
    pulses: new Map<string, number>(),
    engaged: false,
    clock: now,
    decorations: DecorationSet.empty,
  };
}

function isIdle(state: TheaterState): boolean {
  return (
    state.playing === null && state.queue.length === 0 && state.pulses.size === 0
  );
}

export interface AgentTypingOptions {
  /**
   * The document's changed-block tracker, which answers whether the document
   * has arrived. `null` draws nothing — which is what an editor with no reader
   * wants.
   */
  marks: ChangedBlocks | null;
  /** Injectable for tests; reads the media query by default. */
  reducedMotion: () => boolean;
  /** Injectable for tests, so a schedule can be made deterministic. */
  random: () => number;
  /**
   * The clock the animation frame loop stamps on its ticks. Injectable so a
   * test can hold time still: the loop keeps running under jsdom, and a test
   * driving playback by hand would otherwise be racing the wall clock.
   */
  now: () => number;
}

/**
 * The media query, asked once and kept — `matches` is live, so a reader who
 * turns the preference on mid-session still gets the next edit instantly. Kept
 * rather than re-queried because this is read on the keystroke path.
 */
let motionQuery: MediaQueryList | null | undefined;

function systemReducedMotion(): boolean {
  if (motionQuery === undefined) {
    motionQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  }
  return motionQuery?.matches ?? false;
}

/** Where each prose block is, by id. */
type BlockIndex = Map<string, { pos: number; node: ProseMirrorNode }>;

function indexBlocks(doc: ProseMirrorNode): BlockIndex {
  const index: BlockIndex = new Map();
  doc.forEach((node, offset) => {
    const id: unknown = node.attrs.id;
    if (typeof id === "string" && id !== "") index.set(id, { pos: offset, node });
  });
  return index;
}

/** The prose blocks a selection touches — the ones the reader has claimed. */
function blocksUnderSelection(
  doc: ProseMirrorNode,
  selection: Selection,
): Set<string> {
  const claimed = new Set<string>();
  doc.forEach((node, offset) => {
    if (offset > selection.to || offset + node.nodeSize < selection.from) return;
    const id: unknown = node.attrs.id;
    if (typeof id === "string") claimed.add(id);
  });
  return claimed;
}

/** The text of every prose block in a document, by id. */
function proseTextById(doc: ProseMirrorNode): Map<string, string> {
  const texts = new Map<string, string>();
  doc.forEach((node) => {
    if (!PROSE_BLOCKS.has(node.type.name)) return;
    const id: unknown = node.attrs.id;
    if (typeof id === "string" && id !== "") texts.set(id, node.textContent);
  });
  return texts;
}

/**
 * The takes a transaction brings, or none.
 *
 * Only a transaction y-prosemirror marked as change origin carries somebody
 * else's writing. An undo/redo is excluded even though it arrives the same way:
 * the Yjs undo manager is this client's own, and replaying the reader's undo
 * back at them as an agent typing would be a lie.
 */
function takesFrom(
  transaction: Transaction,
  after: EditorState,
  random: () => number,
): Take[] {
  const change: unknown = transaction.getMeta(ySyncPluginKey);
  if (change === null || typeof change !== "object") return [];
  const { isChangeOrigin, isUndoRedoOperation } = change as {
    isChangeOrigin?: unknown;
    isUndoRedoOperation?: unknown;
  };
  if (isChangeOrigin !== true || isUndoRedoOperation === true) return [];

  const before = proseTextById(transaction.before);
  const takes: Take[] = [];
  for (const [id, text] of proseTextById(after.doc)) {
    // A block with no `before` entry is one that has just arrived, prose or
    // re-typed into prose. Either way it reads as text being written from
    // nothing, which is exactly what a pure insertion plays as.
    const splice = spliceBetween(before.get(id) ?? "", text);
    if (splice === null) continue;
    const times = typeSchedule(splice.inserted, random);
    const typing = times.length === 0 ? 0 : (times[times.length - 1] ?? 0);
    takes.push({
      ...splice,
      id,
      text,
      times,
      duration: (splice.removed.length > 0 ? STRIKE_MS : 0) + typing,
    });
  }
  return takes;
}

/** Is this take still describing the block it was built from? */
function stillApplies(take: Take, index: BlockIndex): boolean {
  const found = index.get(take.id);
  return found !== undefined && found.node.textContent === take.text;
}

function withPulse(
  pulses: ReadonlyMap<string, number>,
  id: string,
  now: number,
): Map<string, number> {
  const next = new Map(pulses);
  next.set(id, now + PULSE_MS);
  return next;
}

function makeRemovedDom(take: Take, going: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = going
    ? `${REMOVED_CLASS} ${REMOVED_GOING_CLASS}`
    : REMOVED_CLASS;
  span.contentEditable = "false";
  span.setAttribute("aria-hidden", "true");
  span.textContent = take.removed;
  return span;
}

function makeCaretDom(): HTMLElement {
  const span = document.createElement("span");
  span.className = CARET_CLASS;
  span.contentEditable = "false";
  span.setAttribute("aria-hidden", "true");
  return span;
}

function decorate(doc: ProseMirrorNode, state: TheaterState): DecorationSet {
  const index = indexBlocks(doc);
  const decorations: Decoration[] = [];

  for (const id of state.pulses.keys()) {
    const found = index.get(id);
    if (found === undefined) continue;
    decorations.push(
      Decoration.node(found.pos, found.pos + found.node.nodeSize, {
        class: PULSE_CLASS,
      }),
    );
  }

  /** Everything one take draws, at whatever point it has reached. */
  const draw = (take: Take, elapsed: number | null): void => {
    const found = index.get(take.id);
    if (found === undefined) return;
    const start = found.pos + 1;
    const spliceAt = start + take.at;
    // `null` elapsed is a take still waiting its turn: the block keeps looking
    // like its old self.
    const strikeFor = take.removed.length > 0 ? STRIKE_MS : 0;
    const striking = elapsed !== null && elapsed < strikeFor;
    const waiting = elapsed === null;

    if (take.removed.length > 0 && (waiting || striking)) {
      decorations.push(
        Decoration.widget(spliceAt, () => makeRemovedDom(take, striking), {
          // The phase is part of the key, so the widget's DOM is reused while
          // the phase holds. A widget rebuilt every frame would restart its CSS
          // animation every frame and never visibly play at all.
          key: `out:${take.id}:${striking ? "going" : "waiting"}`,
          side: -1,
          ignoreSelection: true,
        }),
      );
    }

    const revealed =
      waiting || striking
        ? 0
        : revealedBy(take.times, (elapsed ?? 0) - strikeFor);
    const frontier = spliceAt + revealed;
    const insertedEnd = spliceAt + take.inserted.length;
    if (frontier < insertedEnd) {
      decorations.push(
        Decoration.inline(frontier, insertedEnd, { class: VEIL_CLASS }),
      );
    }
    if (!waiting && !striking && frontier < insertedEnd) {
      decorations.push(
        Decoration.widget(frontier, makeCaretDom, {
          key: `caret:${take.id}`,
          side: 1,
          ignoreSelection: true,
        }),
      );
    }
  };

  if (state.playing !== null) {
    draw(state.playing.take, state.clock - state.playing.startedAt);
  }
  for (const take of state.queue) draw(take, null);

  return DecorationSet.create(doc, decorations);
}

/**
 * How many advance steps one transaction may take. A tab that was in the
 * background for a minute comes back with a huge elapsed time; the queue drains
 * to whatever is still due rather than replaying a minute of theater, and the
 * bound stops that drain from being unbounded work.
 */
const MAX_STEPS_PER_TICK = 64;

function reduce(
  transaction: Transaction,
  previous: TheaterState,
  after: EditorState,
  options: AgentTypingOptions,
): TheaterState {
  const marks = options.marks;
  const meta: unknown = transaction.getMeta(typingTheaterPluginKey);
  const tick =
    meta !== null && typeof meta === "object" ? (meta as { now?: unknown }) : {};
  const now = typeof tick.now === "number" ? tick.now : previous.clock;

  // Once the reader has aimed a caret in here, their selection is a real
  // selection and a block under it is theirs. Before that it is ProseMirror's
  // default — the top of the document — which must not veto the first block's
  // animation.
  //
  // Two ways to get this wrong, both of which claim the first block of every
  // document for a caret nobody placed, and both of which killed the feature
  // outright while every other test stayed green:
  //
  // - **Counting a y-prosemirror transaction.** It restores the selection
  //   through the very transaction it applies the remote change in, so
  //   `selectionSet` is true on every remote edit that arrives.
  // - **Counting any local document change.** The editor binds before the
  //   document has synced, so ProseMirror renders its own empty placeholder
  //   paragraph — and `BlockIds` immediately appends a local, id-assigning
  //   transaction over it. That is the editor talking to itself at load, not a
  //   reader.
  //
  // So the signal is a selection the reader set, and only that. Clicking and
  // typing both set one; nothing at load does. A local *edit* needs no such
  // signal, because a take whose block the reader has changed is dropped by the
  // validity check below whatever this says.
  const readersOwn = transaction.getMeta(ySyncPluginKey) === undefined;
  const engaged = previous.engaged || (readersOwn && transaction.selectionSet);

  let playing = previous.playing;
  let queue = previous.queue;
  let pulses = previous.pulses;

  const arrived = marks?.recording() ?? false;
  const enabled = arrived && !options.reducedMotion();
  if (enabled) {
    queue = [...queue, ...takesFrom(transaction, after, options.random)];
  } else {
    playing = null;
    queue = [];
  }

  // The reader wins: nothing is hidden under their cursor, and touching a block
  // that is waiting or playing shows it at once. No pulse — they are looking
  // right at it.
  if (engaged && (playing !== null || queue.length > 0)) {
    const claimed = blocksUnderSelection(after.doc, after.selection);
    if (claimed.size > 0) {
      queue = queue.filter((take) => !claimed.has(take.id));
      if (playing !== null && claimed.has(playing.take.id)) playing = null;
    }
  }

  // A take whose block has moved on describes a document that is gone: its
  // offsets would veil the wrong characters and its removed text would be a
  // sentence nobody deleted.
  //
  // This is also the whole of the replace-on-second-edit rule, which is why
  // there is no code above that looks for a take with the same block id. A
  // second edit to a block arrives *after* the first take was built, so that
  // take's `text` is no longer what the block says and it is dropped right
  // here — leaving the new take alone in the queue, and the block playing once
  // to its final state. Deleting a take by id as well would be a second way to
  // say the same thing, and a second way to get it wrong.
  if (transaction.docChanged && (playing !== null || queue.length > 0)) {
    const index = indexBlocks(after.doc);
    queue = queue.filter((take) => stillApplies(take, index));
    if (playing !== null && !stillApplies(playing.take, index)) playing = null;
  }

  for (let step = 0; step < MAX_STEPS_PER_TICK; step += 1) {
    if (playing !== null && now - playing.startedAt < playing.take.duration) {
      break;
    }
    playing = null;
    const next = queue[0];
    if (next === undefined) break;
    queue = queue.slice(1);
    playing = { take: next, startedAt: now };
  }

  // The backlog is bounded; one take is not. `length > 1` is what guarantees
  // that: the newest pending take is never dropped for being long.
  let backlog = queue.reduce((total, take) => total + take.duration, 0);
  while (backlog > BACKLOG_MS && queue.length > 1) {
    const dropped = queue[0];
    if (dropped === undefined) break;
    backlog -= dropped.duration;
    queue = queue.slice(1);
    pulses = withPulse(pulses, dropped.id, now);
  }

  if (pulses.size > 0) {
    const live = new Map<string, number>();
    for (const [id, until] of pulses) {
      if (until > now) live.set(id, until);
    }
    if (live.size !== pulses.size) pulses = live;
  }

  const state: TheaterState = {
    playing,
    queue,
    pulses,
    engaged,
    clock: now,
    decorations: DecorationSet.empty,
  };
  if (isIdle(state)) return state;
  return { ...state, decorations: decorate(after.doc, state) };
}

/** requestAnimationFrame where there is one — a background tab should not act. */
function frames(): {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
} {
  if (typeof requestAnimationFrame === "function") {
    return {
      request: (callback) => requestAnimationFrame(() => callback()),
      cancel: (handle) => cancelAnimationFrame(handle),
    };
  }
  return {
    request: (callback) => setTimeout(callback, 16) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
  };
}

function nowMs(): number {
  if (typeof performance === "object" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export const AgentTypingTheater = Extension.create<AgentTypingOptions>({
  name: "uberblickAgentTyping",

  addOptions() {
    return {
      marks: null,
      reducedMotion: systemReducedMotion,
      random: Math.random,
      now: nowMs,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    if (options.marks === null) return [];
    return [
      new Plugin<TheaterState>({
        key: typingTheaterPluginKey,
        state: {
          init: () => idleState(options.now()),
          apply: (transaction, previous, _old, next) =>
            reduce(transaction, previous, next, options),
        },
        props: {
          decorations: (state) =>
            typingTheaterPluginKey.getState(state)?.decorations ?? null,
        },
        view: (view) => {
          const clock = frames();
          let handle: number | null = null;

          const tick = (): void => {
            handle = null;
            if (view.isDestroyed) return;
            const state = typingTheaterPluginKey.getState(view.state);
            if (state === undefined || isIdle(state)) return;
            // Empty but for its meta: no steps, so nothing reaches the Y.Doc.
            view.dispatch(
              view.state.tr.setMeta(typingTheaterPluginKey, {
                now: options.now(),
              }),
            );
          };

          const schedule = (): void => {
            if (handle === null) handle = clock.request(tick);
          };

          return {
            update: (updated) => {
              const state = typingTheaterPluginKey.getState(updated.state);
              if (state !== undefined && !isIdle(state)) schedule();
            },
            destroy: () => {
              if (handle !== null) clock.cancel(handle);
              handle = null;
            },
          };
        },
      }),
    ];
  },
});
