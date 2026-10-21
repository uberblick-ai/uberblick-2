// @vitest-environment node
/**
 * The local settings store: one namespaced key, a subscription open UI
 * can follow, and defaults rather than a crash when what is in storage is not
 * what was written — a setting that cannot be read is a setting nobody can
 * repair.
 */

import { beforeEach, describe, expect, it } from "vitest";
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

  it("stores a trimmed presence name without changing the other preferences, and clears it back to the default", () => {
    setSetting("presenceColor", "#0675c9");
    setSetting("appearance", "dark");
    setSetting("presenceName", "  Jos\u00e9 Editor  ");
    expect(getSetting("presenceName")).toBe("Jos\u00e9 Editor");
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) as string)).toEqual({
      presenceColor: "#0675c9", appearance: "dark", presenceName: "Jos\u00e9 Editor",
    });

    setSetting("presenceName", " \t\n ");
    expect(getSetting("presenceName")).toBeNull();
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) as string)).toEqual({
      presenceColor: "#0675c9", appearance: "dark",
    });
    setSetting("presenceColor", null);
    setSetting("appearance", null);
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
  });

  it("refuses unusable stored names independently of a valid colour", () => {
    for (const presenceName of [undefined, null, 42, {}, [], "", " \t\n "]) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ presenceColor: "#0675c9", presenceName }));
      expect(getSetting("presenceName")).toBeNull();
      expect(getSetting("presenceColor")).toBe("#0675c9");
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ presenceName: "  Pat Editor  " }));
    expect(getSetting("presenceName")).toBe("Pat Editor");
  });

});
