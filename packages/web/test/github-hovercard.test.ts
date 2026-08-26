/**
 * GitHub reference hovercards (#175).
 *
 * The card is the only part of uberblick that talks to a third party from the
 * browser, so what is defended here is the boundary rather than the layout:
 *
 * 1. With a token, a hover paints what GitHub answered — the three states, the
 *    size of a pull request, the same-repo and cross-repo forms.
 * 2. Without one, nothing is requested at all; the card says where a token
 *    goes.
 * 3. Every way a request can fail ends in no card, never a broken one.
 * 4. The token is carried in the `Authorization` header and reaches nothing
 *    else — the document, its export and its copied text are byte-identical
 *    with and without one.
 * 5. The keyboard reaches it and Escape gives focus back, and the caret-reveal
 *    rule of #168 still wins: a reference the reader is editing has no card.
 *
 * `fetch` is stubbed throughout; nothing here touches the network. The intent
 * delay is configured to zero so the tests do not spend 400ms each waiting for
 * a pointer that is already resting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { appendBlock, exportMarkdown, initDoc } from "@uberblick/schema";
import { GITHUB_REPO } from "../src/config.js";
import { HOVERCARD_CLASS } from "../src/editor/github-hovercard.js";
import { setSetting } from "../src/settings.js";
import { mountEditor } from "./helpers.js";

const TOKEN = "github_pat_example";
const ISSUE_URL = `https://github.com/${GITHUB_REPO}/issues/58`;
const PR_URL = `https://github.com/${GITHUB_REPO}/pull/62`;
const FOREIGN_PR_URL = "https://github.com/yjs/yjs/pull/1234";

const DAY = 24 * 60 * 60 * 1000;
const THREE_DAYS_AGO = new Date(Date.now() - 3 * DAY).toISOString();

const AUTHOR = {
  login: "bk-one",
  avatar_url: "https://avatars.githubusercontent.com/u/1",
};

/** What `GET /issues/58` answers for an open issue. */
const OPEN_ISSUE = {
  title: "Shorten GitHub links",
  state: "open",
  created_at: THREE_DAYS_AGO,
  user: AUTHOR,
};

/** The same endpoint for a pull request: an issue that carries `pull_request`. */
const PR_ISSUE = {
  title: "Hovercards on shortened links",
  state: "closed",
  created_at: THREE_DAYS_AGO,
  user: AUTHOR,
  pull_request: { merged_at: THREE_DAYS_AGO },
};

const MERGED_PULL = {
  state: "closed",
  merged: true,
  additions: 12,
  deletions: 4,
  changed_files: 3,
};

const CLOSED_PULL = {
  state: "closed",
  merged: false,
  additions: 1,
  deletions: 1,
  changed_files: 1,
};

/** One recorded request: where it went, and what it carried. */
interface Sent {
  url: string;
  authorization: string | null;
}

/** How the stub answers one URL. `fail` is the network refusing outright. */
interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  fail?: boolean;
}

/** A stubbed api.github.com, and the log of what was actually sent to it. */
function stubGithub(answer: (url: string) => Answer): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: { headers?: Record<string, string> }) => {
      sent.push({ url, authorization: init?.headers?.Authorization ?? null });
      const given = answer(url);
      if (given.fail === true) throw new TypeError("Failed to fetch");
      const status = given.status ?? 200;
      const headers = new Map(Object.entries(given.headers ?? {}));
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => headers.get(name) ?? null },
        json: async () => given.body,
      };
    },
  );
  return sent;
}

/** The happy path: the issue endpoint, then the pull endpoint when asked. */
function stubIssueAndPull(issue: unknown, pull: unknown): Sent[] {
  return stubGithub((url) => ({ body: url.includes("/pulls/") ? pull : issue }));
}

let editors: Editor[] = [];

beforeEach(() => {
  // Node's own experimental localStorage shadows jsdom's and is unusable
  // without a file, so the settings module gets the one thing it needs.
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
  // Also empties the session cache — settings changed, so what an older token
  // was told says nothing about this test.
  setSetting("githubToken", null);
});

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
  vi.unstubAllGlobals();
  for (const stale of document.querySelectorAll(`.${HOVERCARD_CLASS}`)) {
    stale.remove();
  }
});

interface Mounted {
  ydoc: Y.Doc;
  editor: Editor;
  element: HTMLElement;
}

/**
 * A paragraph holding a bare GitHub URL, plus an empty one to park the caret
 * in: a caret inside the link is a case of its own, and no test may leave it
 * there by accident.
 */
function mount(href: string): Mounted {
  const ydoc = new Y.Doc();
  initDoc(ydoc, { uuid: "gh-card-doc", title: "Refs" });
  appendBlock(ydoc, {
    type: "paragraph",
    inline: [{ text: href, marks: { link: href } }],
  });
  appendBlock(ydoc, { type: "paragraph", text: "" });
  const { editor, element } = mountEditor(ydoc, { hovercard: { delayMs: 0 } });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
  return { ydoc, editor, element };
}

/** The shortened reference on screen. */
function reference(element: HTMLElement): HTMLAnchorElement {
  const anchor = element.querySelector<HTMLAnchorElement>("a.ub-gh-ref");
  if (anchor === null) throw new Error("no shortened reference was drawn");
  return anchor;
}

/** The card, wherever in the portal it landed. */
function card(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.${HOVERCARD_CLASS}`);
}

function chip(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ub-hovercard-state");
}

function said(selector: string): string | null {
  return document.querySelector(selector)?.textContent ?? null;
}

function hover(anchor: HTMLElement): void {
  anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function unhover(anchor: HTMLElement): void {
  anchor.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
}

/** Let the stubbed request and everything chained to it finish. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Hover and wait for whatever the card is going to be. */
async function hoverAndSettle(anchor: HTMLElement): Promise<void> {
  hover(anchor);
  await settle();
}

describe("a hovercard on a shortened reference", () => {
  it("shows an open issue's state, title, author and age", async () => {
    setSetting("githubToken", TOKEN);
    const sent = stubIssueAndPull(OPEN_ISSUE, null);
    const { element } = mount(ISSUE_URL);

    await hoverAndSettle(reference(element));

    expect(chip()?.textContent).toBe("Open");
    expect(chip()?.className).toContain("ub-hovercard-state-open");
    expect(said(".ub-hovercard-ref")).toBe("#58");
    expect(said(".ub-hovercard-title")).toBe(OPEN_ISSUE.title);
    expect(said(".ub-hovercard-author")).toBe(AUTHOR.login);
    expect(said(".ub-hovercard-age")).toBe("3 days ago");
    expect(
      document.querySelector<HTMLImageElement>(".ub-hovercard-avatar")?.src,
    ).toBe(AUTHOR.avatar_url);
    // An issue has no size, and the second endpoint is never asked.
    expect(document.querySelector(".ub-hovercard-size")).toBeNull();
    expect(sent.map((request) => request.url)).toEqual([
      `https://api.github.com/repos/${GITHUB_REPO}/issues/58`,
    ]);
  });

  it("shows a merged pull request's size, naming the other repository", async () => {
    setSetting("githubToken", TOKEN);
    const sent = stubIssueAndPull(PR_ISSUE, MERGED_PULL);
    const { element } = mount(FOREIGN_PR_URL);

    await hoverAndSettle(reference(element));

    expect(chip()?.textContent).toBe("Merged");
    expect(chip()?.className).toContain("ub-hovercard-state-merged");
    expect(said(".ub-hovercard-ref")).toBe("yjs/yjs#1234");
    expect(said(".ub-hovercard-adds")).toBe("+12");
    expect(said(".ub-hovercard-dels")).toBe("−4");
    expect(said(".ub-hovercard-files")).toBe("3 files");
    expect(sent.map((request) => request.url)).toEqual([
      "https://api.github.com/repos/yjs/yjs/issues/1234",
      "https://api.github.com/repos/yjs/yjs/pulls/1234",
    ]);
  });

  it("shows a closed pull request as closed, not merged", async () => {
    setSetting("githubToken", TOKEN);
    stubIssueAndPull(PR_ISSUE, CLOSED_PULL);
    const { element } = mount(PR_URL);

    await hoverAndSettle(reference(element));

    expect(chip()?.textContent).toBe("Closed");
    expect(chip()?.className).toContain("ub-hovercard-state-closed");
    expect(said(".ub-hovercard-files")).toBe("1 file");
  });

  it("carries the token in the Authorization header and nowhere else", async () => {
    setSetting("githubToken", TOKEN);
    const sent = stubIssueAndPull(OPEN_ISSUE, null);
    const { element } = mount(ISSUE_URL);

    await hoverAndSettle(reference(element));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]?.url).not.toContain(TOKEN);
    expect(card()?.textContent).not.toContain(TOKEN);
  });

  it("points at Settings and fetches nothing when no token is configured", async () => {
    const sent = stubIssueAndPull(OPEN_ISSUE, null);
    const { element } = mount(ISSUE_URL);

    await hoverAndSettle(reference(element));

    expect(said(".ub-hovercard-hint")).toBe(
      "Connect GitHub in Settings → Connections to see titles and state.",
    );
    // The whole point of rule 1: no token, no request.
    expect(sent).toHaveLength(0);
    // And no input either — repair lives in Settings, not in a card.
    expect(document.querySelector(`.${HOVERCARD_CLASS} input`)).toBeNull();
  });

  it.each([
    ["a rejected token", { status: 401 }],
    ["a reference that is gone", { status: 404 }],
    [
      "a spent rate limit",
      { status: 403, headers: { "x-ratelimit-remaining": "0" } },
    ],
    ["a network that refused", { fail: true }],
  ])("shows no card at all for %s", async (_case, answer: Answer) => {
    setSetting("githubToken", TOKEN);
    stubGithub(() => answer);
    const { element } = mount(ISSUE_URL);

    await hoverAndSettle(reference(element));

    expect(card()).toBeNull();
    // The link is untouched — which is what "degrades to the plain link" means.
    expect(reference(element).getAttribute("href")).toBe(ISSUE_URL);
  });

  it("asks GitHub once, however often the reference is hovered", async () => {
    setSetting("githubToken", TOKEN);
    const sent = stubIssueAndPull(OPEN_ISSUE, null);
    const { element } = mount(ISSUE_URL);
    const anchor = reference(element);

    await hoverAndSettle(anchor);
    expect(card()).not.toBeNull();

    unhover(anchor);
    expect(card()).toBeNull();

    await hoverAndSettle(anchor);
    expect(card()).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("opens on focus and Escape closes it and gives focus back", async () => {
    setSetting("githubToken", TOKEN);
    stubIssueAndPull(OPEN_ISSUE, null);
    const { element } = mount(ISSUE_URL);
    const anchor = reference(element);

    anchor.focus();
    await settle();
    expect(card()).not.toBeNull();
    // The card is described *by* the link, never focused itself: Tab order is
    // still the prose's own.
    expect(anchor.getAttribute("aria-describedby")).toBe(card()?.id);

    const dismiss = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    anchor.dispatchEvent(dismiss);

    expect(card()).toBeNull();
    expect(document.activeElement).toBe(anchor);
    // Handled here, so the drawer and the settings dialog stand down.
    expect(dismiss.defaultPrevented).toBe(true);
    expect(anchor.getAttribute("aria-describedby")).toBeNull();
  });

  it("has no card while the caret is in the link", async () => {
    setSetting("githubToken", TOKEN);
    const sent = stubIssueAndPull(OPEN_ISSUE, null);
    const { editor, element } = mount(ISSUE_URL);

    await hoverAndSettle(reference(element));
    expect(card()).not.toBeNull();

    // The caret enters the link: #168 drops the decoration to show the URL, and
    // the card describing a reference that is no longer on screen goes with it.
    editor.commands.setTextSelection(5);
    expect(card()).toBeNull();
    expect(element.querySelector("a.ub-gh-ref")).toBeNull();

    // Hovering the revealed URL is not hovering a reference.
    const plain = element.querySelector<HTMLAnchorElement>("a.ub-link");
    expect(plain?.textContent).toBe(ISSUE_URL);
    await hoverAndSettle(plain as HTMLElement);
    expect(card()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("leaves the document, its export and its copied text byte-identical", async () => {
    const sent = stubIssueAndPull(OPEN_ISSUE, null);
    const { ydoc, editor, element } = mount(ISSUE_URL);

    // Once with no token…
    await hoverAndSettle(reference(element));
    expect(sent).toHaveLength(0);
    const markdownBefore = exportMarkdown(ydoc);
    const copiedBefore = editor.state.doc.textBetween(
      0,
      editor.state.doc.content.size,
      "\n",
    );

    // …and once with one, card and all.
    unhover(reference(element));
    setSetting("githubToken", TOKEN);
    await hoverAndSettle(reference(element));
    expect(card()).not.toBeNull();

    expect(exportMarkdown(ydoc)).toBe(markdownBefore);
    expect(
      editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n"),
    ).toBe(copiedBefore);
    // The URL is what is stored, exported and copied — never the title, and
    // never the token.
    expect(markdownBefore).toContain(ISSUE_URL);
    expect(markdownBefore).not.toContain(TOKEN);
    expect(copiedBefore).not.toContain(TOKEN);
  });
});
