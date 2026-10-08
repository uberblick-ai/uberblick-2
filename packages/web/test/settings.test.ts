// @vitest-environment node
/**
 * The local settings store (#176): one namespaced key, a subscription open UI
 * can follow, and defaults rather than a crash when what is in storage is not
 * what was written — a setting that cannot be read is a setting nobody can
 * repair.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SETTINGS_KEY,
  getSetting,
  setSetting,
  subscribeSettings,
} from "../src/settings.js";

/**
 * A fresh in-memory Storage. Node's own experimental `localStorage` global is
 * unusable without `--localstorage-file`, so the test provides the one thing
 * the settings module needs.
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

beforeEach(() => {
  installStorage();
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
