/**
 * Hovercards on the shortened GitHub references of github-refs.ts (#175).
 *
 * Hovering — or tabbing to — a reference asks github.com what it is and draws
 * the answer the way GitHub itself does: a state chip, `repo#N`, the title, the
 * author, how old it is, and for a pull request its size. Display only, like
 * the decoration it sits on: nothing here touches the Y.Doc, so a document
 * exports and copies identically whether a card ever appeared or not.
 *
 * Four rules define it.
 *
 * 1. **Opt-in, and silent without it.** The token comes from the settings store
 *    (#176) and lives in this browser only. With no token the card is one line
 *    pointing at Settings → Connections and *no request is made*; the card
 *    never asks for a token itself, because token entry, validation and removal
 *    belong to one surface and this is not it.
 * 2. **Every failure is no card.** A rejected token, a deleted issue, a
 *    rate-limited hour, an aeroplane — all of them leave the shortened link
 *    exactly as it was. A card that said "401" would be a repair prompt in the
 *    wrong place, and a half-populated one would be worse than none.
 * 3. **Hover intent, and one fetch per reference.** A pointer crossing a link
 *    on its way somewhere else is not a request for anything, so the card waits
 *    {@link HOVER_INTENT_MS}; the keyboard has no such ambiguity and shows it at
 *    once. Answers are cached per URL for {@link REF_TTL_MS}, in memory and for
 *    this session only, so re-hovering, re-rendering and two references to the
 *    same issue cost one request between them. There is deliberately no
 *    doc-open prefetch: a document full of references would spend a rate limit
 *    on cards nobody looked at.
 * 4. **The reference is still just a link.** The card is a tooltip in a portal
 *    on `document.body`, never focused and holding nothing interactive, so Tab
 *    order is untouched; Escape dismisses it and puts focus back on the link.
 *
 * The cache is cleared whenever settings change: what was learned with one
 * token (including that something was not readable) says nothing about the
 * next, and a reader who has just connected in Settings should see cards on
 * their next hover rather than in five minutes.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { getSetting, subscribeSettings } from "../settings.js";
import { GITHUB_REF_CLASS, parseGitHubRef, shortGitHubRef } from "./github-refs.js";

/** The class on the card itself. */
export const HOVERCARD_CLASS = "ub-hovercard";

/** How long a pointer must rest on a reference before it means it. */
export const HOVER_INTENT_MS = 400;

/** How long an answer from GitHub is reused. */
export const REF_TTL_MS = 5 * 60_000;

/** The card's id, so the reference can point at it with `aria-describedby`. */
const CARD_ID = "ub-hovercard";

const API = "https://api.github.com";

/** What a card shows. Everything is required except what GitHub may omit. */
export interface RefFacts {
  state: "open" | "merged" | "closed";
  /** The reference as github-refs.ts would shorten it — `#62`, `org/repo#62`. */
  label: string;
  title: string;
  author: string;
  avatarUrl: string | null;
  /** ISO 8601, as GitHub sends it. */
  createdAt: string;
  /** Pull requests only; an issue has no size. */
  size: { additions: number; deletions: number; files: number } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * One GET against the API, or `null` for every way it can fail to answer.
 *
 * Rule 2 lives here: a network error, a 401, a 404 and a rate-limited 403 are
 * one outcome — nothing to show — and the caller cannot tell them apart because
 * it would do the same thing with each.
 */
async function get(
  url: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return record(await response.json());
  } catch {
    return null;
  }
}

/**
 * What GitHub says about the reference `href` points at.
 *
 * `GET /issues/{n}` answers for both kinds — a pull request is an issue that
 * carries a `pull_request` key — so an issue costs one request and only a pull
 * request pays for the second, which is the one that knows about merges and
 * sizes.
 */
async function readRef(
  href: string,
  token: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<RefFacts | null> {
  const ref = parseGitHubRef(href);
  const label = shortGitHubRef(href);
  if (ref === null || label === null) return null;
  const base = `${API}/repos/${ref.owner}/${ref.repo}`;
  const issue = await get(`${base}/issues/${ref.number}`, token, fetchImpl);
  if (issue === null) return null;
  const title = text(issue.title);
  const createdAt = text(issue.created_at);
  const user = record(issue.user);
  const author = user === null ? null : text(user.login);
  // A card missing the fields it exists to show is a broken card, so it is no
  // card — the same answer as any other unusable response.
  if (title === null || createdAt === null || author === null) return null;
  const common = {
    label,
    title,
    author,
    avatarUrl: user === null ? null : text(user.avatar_url),
    createdAt,
  };
  if (issue.pull_request === undefined || issue.pull_request === null) {
    return {
      ...common,
      state: issue.state === "closed" ? "closed" : "open",
      size: null,
    };
  }
  const pull = await get(`${base}/pulls/${ref.number}`, token, fetchImpl);
  if (pull === null) return null;
  return {
    ...common,
    // Merged is a third state, not a flavour of closed: it is the one a reader
    // scanning references is usually looking for.
    state: pull.merged === true ? "merged" : pull.state === "closed" ? "closed" : "open",
    size: {
      additions: count(pull.additions),
      deletions: count(pull.deletions),
      files: count(pull.changed_files),
    },
  };
}

interface CacheEntry {
  at: number;
  facts: Promise<RefFacts | null>;
}

const cache = new Map<string, CacheEntry>();

// See the file comment: an answer is only as good as the token that fetched it.
subscribeSettings(() => cache.clear());

/**
 * The facts for `href`, from the session cache when they are fresh enough.
 *
 * The *promise* is cached rather than its value, so two hovers that overlap in
 * flight join one request instead of racing two.
 */
export function refFacts(
  href: string,
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<RefFacts | null> {
  const held = cache.get(href);
  if (held !== undefined && now() - held.at < REF_TTL_MS) return held.facts;
  const facts = readRef(href, token, fetchImpl);
  cache.set(href, { at: now(), facts });
  return facts;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** `3 days ago`, at the coarseness a reader actually reads. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const ago = Math.max(0, now - then);
  const [amount, unit] =
    ago < HOUR
      ? [Math.floor(ago / MINUTE), "minute"]
      : ago < DAY
        ? [Math.floor(ago / HOUR), "hour"]
        : ago < MONTH
          ? [Math.floor(ago / DAY), "day"]
          : ago < YEAR
            ? [Math.floor(ago / MONTH), "month"]
            : [Math.floor(ago / YEAR), "year"];
  if (amount < 1) return "just now";
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
}

const STATE_LABEL: Record<RefFacts["state"], string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

function element(tag: string, className: string, content = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (content !== "") node.textContent = content;
  return node;
}

/** The populated card. */
function cardBody(facts: RefFacts, now: number): HTMLElement {
  const body = element("div", "ub-hovercard-body");

  const head = element("div", "ub-hovercard-head");
  head.append(
    element(
      "span",
      `ub-hovercard-state ub-hovercard-state-${facts.state}`,
      STATE_LABEL[facts.state],
    ),
    element("span", "ub-hovercard-ref", facts.label),
  );
  body.append(head, element("div", "ub-hovercard-title", facts.title));

  const meta = element("div", "ub-hovercard-meta");
  if (facts.avatarUrl !== null) {
    const avatar = document.createElement("img");
    avatar.className = "ub-hovercard-avatar";
    avatar.src = facts.avatarUrl;
    // Decorative: the login is right beside it, and reading it twice is noise.
    avatar.alt = "";
    avatar.width = 16;
    avatar.height = 16;
    meta.append(avatar);
  }
  meta.append(
    element("span", "ub-hovercard-author", facts.author),
    element("span", "ub-hovercard-age", relativeAge(facts.createdAt, now)),
  );
  body.append(meta);

  if (facts.size !== null) {
    const size = element("div", "ub-hovercard-size");
    size.append(
      element("span", "ub-hovercard-adds", `+${facts.size.additions}`),
      element("span", "ub-hovercard-dels", `−${facts.size.deletions}`),
      element(
        "span",
        "ub-hovercard-files",
        `${facts.size.files} file${facts.size.files === 1 ? "" : "s"}`,
      ),
    );
    body.append(size);
  }
  return body;
}

/** The whole card when there is no token: where to put one, and nothing else. */
function tokenHint(): HTMLElement {
  return element(
    "p",
    "ub-hovercard-hint",
    "Connect GitHub in Settings → Connections to see titles and state.",
  );
}

/** The reference an event happened on, or `null` for everything else. */
function refAt(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const found = target.closest(`a.${GITHUB_REF_CLASS}`);
  return found instanceof HTMLAnchorElement ? found : null;
}

export interface GitHubHovercardOptions {
  /** Hover intent, injectable so a test need not wait it out. */
  delayMs: number;
}

/**
 * The card's lifecycle, per editor view.
 *
 * One card at a time and one anchor at a time, which is what makes dismissal
 * simple: there is exactly one thing to take off the page.
 */
function hovercardView(view: EditorView, delayMs: number) {
  /** The reference the card is showing, or is about to. */
  let anchor: HTMLAnchorElement | null = null;
  let card: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every dismissal, so a fetch that lands after the pointer left
   * paints nothing. Without it a slow answer draws a card over prose the reader
   * has already moved on from.
   */
  let generation = 0;
  /**
   * The reference Escape dismissed. Focusing it again — which Escape itself
   * does — must not reopen what was just closed; the reader has to leave and
   * come back.
   */
  let dismissed: HTMLAnchorElement | null = null;

  function place(): void {
    if (card === null || anchor === null) return;
    const rect = anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
    card.style.left = `${left}px`;
    // Below the reference, unless there is no room, in which case above it —
    // measured against the card's own height rather than a guess.
    const below = rect.bottom + 6;
    if (below + card.offsetHeight > window.innerHeight && rect.top > card.offsetHeight) {
      card.style.top = `${rect.top - 6 - card.offsetHeight}px`;
    } else {
      card.style.top = `${below}px`;
    }
  }

  function paint(content: HTMLElement): void {
    if (anchor === null) return;
    card = element("div", HOVERCARD_CLASS);
    card.id = CARD_ID;
    card.setAttribute("role", "tooltip");
    card.append(content);
    document.body.append(card);
    anchor.setAttribute("aria-describedby", CARD_ID);
    place();
    // A card in a portal is positioned against the viewport, so it has to
    // follow the reference when the pane under it scrolls — capture, because
    // the scroll happens on the editor's pane and never reaches the window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    // Capture, so the card is the first thing an Escape reaches: it is the
    // innermost dismissable surface on screen, and the drawer and the dialog
    // both stand down for an Escape somebody has already handled.
    document.addEventListener("keydown", onKeydown, true);
  }

  function close(): void {
    generation += 1;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (card !== null) {
      document.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      card.remove();
      card = null;
    }
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
  }

  function begin(): void {
    const mine = generation;
    const token = getSetting("githubToken");
    // Rule 1: no token, no request — the card says where one goes and stops.
    if (token === null) {
      paint(tokenHint());
      return;
    }
    const href = anchor?.href;
    if (href === undefined) return;
    void refFacts(href, token).then((facts) => {
      // Rule 2: nothing to show is nothing shown.
      if (facts === null || mine !== generation) return;
      paint(cardBody(facts, Date.now()));
    });
  }

  function schedule(target: HTMLAnchorElement, delay: number): void {
    if (target === anchor || target === dismissed) return;
    close();
    anchor = target;
    if (delay <= 0) {
      begin();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      begin();
    }, delay);
  }

  /** The pointer or focus left `target` — for good, not into the reference. */
  function leave(target: HTMLAnchorElement): void {
    if (dismissed === target) dismissed = null;
    if (anchor === target) close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || card === null) return;
    const link = anchor;
    event.preventDefault();
    dismissed = link;
    close();
    link?.focus();
  }

  function onMouseover(event: Event): void {
    const target = refAt(event.target);
    if (target !== null) schedule(target, delayMs);
  }

  function onMouseout(event: Event): void {
    const target = refAt(event.target);
    if (target === null) return;
    const to = (event as MouseEvent).relatedTarget;
    // Moving *within* the reference is not leaving it.
    if (to instanceof Node && target.contains(to)) return;
    leave(target);
  }

  function onFocusin(event: Event): void {
    const target = refAt(event.target);
    // No intent delay: Tab is not something a reader does in passing.
    if (target !== null) schedule(target, 0);
  }

  function onFocusout(event: Event): void {
    const target = refAt(event.target);
    if (target !== null) leave(target);
  }

  const dom = view.dom;
  dom.addEventListener("mouseover", onMouseover);
  dom.addEventListener("mouseout", onMouseout);
  dom.addEventListener("focusin", onFocusin);
  dom.addEventListener("focusout", onFocusout);

  return {
    update(): void {
      // The widget is rebuilt on every doc and selection change, so the anchor
      // a card belongs to can simply cease to exist — the caret entering the
      // link is exactly that (rule 3 of github-refs.ts), and the card must go
      // with it rather than hang over the URL it was describing.
      if (anchor !== null && !anchor.isConnected) close();
      else place();
    },
    destroy(): void {
      close();
      dismissed = null;
      dom.removeEventListener("mouseover", onMouseover);
      dom.removeEventListener("mouseout", onMouseout);
      dom.removeEventListener("focusin", onFocusin);
      dom.removeEventListener("focusout", onFocusout);
    },
  };
}

export const githubHovercardPluginKey = new PluginKey(
  "uberblick/github-hovercard",
);

export const GitHubHovercards = Extension.create<GitHubHovercardOptions>({
  name: "uberblickGithubHovercard",

  addOptions() {
    return { delayMs: HOVER_INTENT_MS };
  },

  addProseMirrorPlugins() {
    const { delayMs } = this.options;
    return [
      new Plugin({
        key: githubHovercardPluginKey,
        view: (view) => hovercardView(view, delayMs),
      }),
    ];
  },
});
