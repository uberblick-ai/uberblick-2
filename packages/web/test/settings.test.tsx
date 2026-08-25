/**
 * Local settings (#176): the store, and the dialog over it.
 *
 * Two contracts are worth pinning. The store's: one namespaced key, a
 * subscription open UI can follow, and defaults rather than a crash when what
 * is in storage is not what was written — a settings surface that cannot open
 * because its own storage is corrupt is a surface nobody can repair.
 *
 * The dialog's: a token is only stored once GitHub has answered for it, and
 * disconnect leaves nothing behind. The `GET /user` call is stubbed, so nothing
 * here reaches the network; what the test asserts about it is that the token is
 * carried in the request and nowhere else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Sidebar } from "../src/ui/Sidebar.js";
import { SettingsDialog } from "../src/ui/SettingsDialog.js";
import {
  SETTINGS_KEY,
  getSetting,
  setSetting,
  subscribeSettings,
} from "../src/settings.js";

/**
 * A fresh in-memory Storage. Node's own experimental `localStorage` global
 * shadows jsdom's here and is unusable without `--localstorage-file`, so the
 * test provides the one thing the settings module needs.
 */
function installStorage(): void {
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
}

/** What is actually in storage under the one settings key. */
function stored(): string | null {
  return localStorage.getItem(SETTINGS_KEY);
}

/**
 * Change an input the way a keystroke does, so React's `onChange` runs.
 *
 * Assigning `.value` is not enough: React installs its own setter on the
 * prototype to track the last value it saw, so a plain assignment updates that
 * record too and the event that follows is dismissed as "nothing changed".
 */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (input === null) return;
  const native = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  native?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

interface View {
  host: HTMLElement;
  root: Root;
  closed: () => number;
  unmount: () => void;
}

function openSettings(): View {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = vi.fn();
  act(() => root.render(<SettingsDialog onClose={close} />));
  return {
    host,
    root,
    closed: () => close.mock.calls.length,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function query<T extends HTMLElement>(host: HTMLElement, selector: string): T | null {
  return host.querySelector<T>(selector);
}

/** The one button whose label says what state the entry is in. */
function action(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

/** One recorded request: where it went, and what it carried. */
interface Sent {
  url: string;
  authorization: string | null;
}

/**
 * A stubbed `GET /user` — the status and body GitHub would answer with, and a
 * log of what was actually sent. Nothing here touches the network.
 */
function stubGithub(status: number, body: unknown): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: { headers?: Record<string, string> }) => {
      sent.push({ url, authorization: init?.headers?.Authorization ?? null });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      };
    },
  );
  return sent;
}

/** Paste a token and press Connect, letting the stubbed request settle. */
async function connect(view: View, token: string): Promise<void> {
  await act(async () => {
    typeInto(query<HTMLInputElement>(view.host, ".ub-setting-input"), token);
  });
  await act(async () => {
    action(view.host, "Connect")?.click();
  });
}

beforeEach(() => {
  installStorage();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the settings dialog", () => {
  it("opens from the sidebar's footer affordance", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const open = vi.fn();
    act(() => {
      root.render(
        <Sidebar
          connection={null}
          sidebar={null}
          groups={[]}
          entries={[]}
          selected={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onOpenSettings={open}
        />,
      );
    });
    act(() => query<HTMLButtonElement>(host, ".ub-settings-open")?.click());
    expect(open).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    host.remove();
  });

  it("closes on Escape and on the close control", () => {
    const view = openSettings();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(view.closed()).toBe(1);
    act(() =>
      query<HTMLButtonElement>(view.host, '[aria-label="Close settings"]')?.click(),
    );
    expect(view.closed()).toBe(2);
    view.unmount();
  });

  it("traps focus: Tab wraps inside the dialog in both directions", () => {
    const view = openSettings();
    const items = [
      ...view.host.querySelectorAll<HTMLElement>("button, input"),
    ].filter((element) => !(element as HTMLButtonElement).disabled);
    const first = items[0];
    const last = items[items.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    // The dialog takes focus on open — a modal that left it behind would put
    // the next keystroke somewhere the reader cannot see.
    expect(document.activeElement).toBe(first);

    const tab = (target: HTMLElement, shiftKey: boolean): void => {
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };
    act(() => last?.focus());
    tab(last!, false);
    expect(document.activeElement).toBe(first);
    tab(first!, true);
    expect(document.activeElement).toBe(last);

    // Focus that got out anyway — the app shell is `inert` while the dialog is
    // up, but a browser that ignores the attribute, or a click that landed
    // before it applied, would leave the reader on a control behind the scrim.
    // The next Tab brings them back rather than walking off through the header.
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(document.activeElement).toBe(outside);
    tab(outside, false);
    expect(document.activeElement).toBe(first);
    outside.remove();
    view.unmount();
  });
});

describe("Connections → GitHub", () => {
  const TOKEN = "github_pat_11ABCDEFG_notarealtoken";

  it("stores a token GitHub answered for, and restores it on a remount", async () => {
    const sent = stubGithub(200, { login: "octocat" });
    const view = openSettings();
    await connect(view, TOKEN);

    // The token is what makes the request — it goes to github.com and nowhere
    // else, and it goes there exactly once.
    expect(sent).toEqual([
      {
        url: "https://api.github.com/user",
        authorization: `Bearer ${TOKEN}`,
      },
    ]);

    expect(view.host.textContent).toContain("connected as octocat");
    expect(getSetting("githubToken")).toBe(TOKEN);
    view.unmount();

    // A reload, in miniature: a second dialog over the same storage. Nothing is
    // sent, so localStorage is the only thing that can be supplying the answer.
    const reopened = openSettings();
    expect(reopened.host.textContent).toContain("connected as octocat");
    expect(sent).toHaveLength(1);
    reopened.unmount();
  });

  it("stores nothing when GitHub rejects the token", async () => {
    stubGithub(401, { message: "Bad credentials" });
    const view = openSettings();
    await connect(view, "github_pat_rejected");

    expect(query(view.host, ".ub-setting-error")?.textContent).toContain("401");
    expect(getSetting("githubToken")).toBeNull();
    expect(stored()).toBeNull();
    // Still the connect state: there is a field to paste into.
    expect(query(view.host, ".ub-setting-input")).not.toBeNull();
    view.unmount();
  });

  it("disconnect removes the token and returns to the connect state", async () => {
    stubGithub(200, { login: "octocat" });
    const view = openSettings();
    await connect(view, TOKEN);
    expect(stored()).toContain(TOKEN);

    act(() => action(view.host, "Disconnect")?.click());
    expect(getSetting("githubToken")).toBeNull();
    expect(getSetting("githubLogin")).toBeNull();
    // Not a stored null — nothing left under the key at all.
    expect(stored()).toBeNull();
    expect(view.host.textContent).not.toContain("connected as");
    expect(query(view.host, ".ub-setting-input")).not.toBeNull();
    view.unmount();
  });
});

describe("the settings store", () => {
  it("notifies subscribers in the same tab", () => {
    const seen: (string | null)[] = [];
    const stop = subscribeSettings(() => seen.push(getSetting("githubLogin")));
    setSetting("githubLogin", "octocat");
    setSetting("githubLogin", null);
    stop();
    setSetting("githubLogin", "ignored");
    expect(seen).toEqual(["octocat", null]);
  });

  it("discards a corrupt value and returns the defaults", () => {
    localStorage.setItem(SETTINGS_KEY, "{not json at all");
    expect(getSetting("githubToken")).toBeNull();
    // A well-formed blob of the wrong shape reads the same way, per field.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ githubToken: 42 }));
    expect(getSetting("githubToken")).toBeNull();
    // And a write over the corruption produces a value that reads back.
    setSetting("githubToken", "t");
    expect(getSetting("githubToken")).toBe("t");
  });

  it("imports nothing from the collab layer", () => {
    // The reason a pasted token cannot reach a document: the module that holds
    // it has no way to name a Y.Doc, a room, or the hub. Static, because the
    // guarantee has to hold for code paths no test exercises.
    const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const source = readFileSync(resolve(webRoot, "src/settings.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*(?:import|export)\s.*?from\s+"([^"]+)"/gm)].map(
      (match) => match[1],
    );
    expect(imports).toEqual([]);
    expect(source).not.toMatch(/collab\/|yjs|@uberblick\//);
  });
});
