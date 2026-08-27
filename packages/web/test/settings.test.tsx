/**
 * Local settings (#176): the store, and the dialog over it.
 *
 * Two contracts are worth pinning. The store's: one namespaced key, a
 * subscription open UI can follow, and defaults rather than a crash when what
 * is in storage is not what was written — a settings surface that cannot open
 * because its own storage is corrupt is a surface nobody can repair.
 *
 * The dialog's: it opens from the sidebar, it closes the two ways a modal has
 * to close, and focus stays inside it while it is up.
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
  // No workspace: this file is about the dialog's own chrome. The Storage
  // section is `forget.test.tsx`, and with no `indexedDB.databases` in jsdom it
  // renders as the "cannot list" notice and adds no controls here.
  act(() => root.render(<SettingsDialog workspace={null} onClose={close} />));
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
          workspaces={[]}
          workspace={null}
          onSwitchWorkspace={() => {}}
          identity={{ name: "settings tab", color: "#0675c9" }}
          agentSessions={0}
          selected={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onOpenAll={() => {}}
          allOpen={false}
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

describe("the settings store", () => {
  it("notifies subscribers in the same tab", () => {
    const seen: (string | null)[] = [];
    const stop = subscribeSettings(() => seen.push(getSetting("presenceColor")));
    setSetting("presenceColor", "#0675c9");
    setSetting("presenceColor", null);
    stop();
    setSetting("presenceColor", "#ff0000");
    expect(seen).toEqual(["#0675c9", null]);
  });

  it("discards a corrupt value and returns the defaults", () => {
    localStorage.setItem(SETTINGS_KEY, "{not json at all");
    expect(getSetting("presenceColor")).toBeNull();
    // A well-formed blob of the wrong shape reads the same way, per field.
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ presenceColor: 42 }));
    expect(getSetting("presenceColor")).toBeNull();
    // And a write over the corruption produces a value that reads back.
    setSetting("presenceColor", "#0675c9");
    expect(getSetting("presenceColor")).toBe("#0675c9");
  });

  it("imports nothing from the collab layer", () => {
    // The reason a local setting cannot reach a document: the module that holds
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
