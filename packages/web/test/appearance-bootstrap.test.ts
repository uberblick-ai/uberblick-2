// @vitest-environment node
/**
 * The appearance stamp that runs before first paint (#74).
 *
 * `src/ui/theme.ts` owns the theme for the life of the session, but it cannot
 * own the *first paint*: it arrives on a deferred module script, and the page
 * is painted well before that. The blocking snippet in `index.html` is the only
 * code that runs early enough, which makes it the one place a reader's choice
 * can be lost — silently, and only on a real page load, where no jsdom suite
 * would ever see it.
 *
 * So the snippet itself is what is executed here: the test reads `index.html`,
 * takes the inline script out of it and runs that text against a stubbed
 * storage and document. A copy of the logic would pass while the shipped page
 * had a typo in it, which is exactly the failure this is for.
 *
 * The contract, in both directions: an explicit choice is stamped, and
 * *everything* else leaves the attribute off — because the absence of the
 * attribute is how "follow the system preference" is spelled in styles.css.
 * Storage that throws is the ordinary private-window case and must not take the
 * page down with it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS_KEY } from "../src/settings.js";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The inline `<script>` from the shipped page — the head one, not the module. */
function bootstrapSource(): string {
  const html = readFileSync(resolve(webRoot, "index.html"), "utf8");
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (inline?.[1] === undefined) {
    throw new Error("index.html has no inline bootstrap script");
  }
  return inline[1];
}

/** What the document holds after the snippet has run over `storage`. */
function stamped(storage: { getItem: (key: string) => string | null }): string | null {
  let attribute: string | null = null;
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        if (name === "data-theme") attribute = value;
      },
    },
  };
  // The snippet is page script, so it reads bare globals: hand it exactly the
  // two it names and nothing else.
  new Function("localStorage", "document", bootstrapSource())(storage, document);
  return attribute;
}

/** Storage holding one settings blob, as the page would find it. */
function holding(raw: string | null): { getItem: (key: string) => string | null } {
  return { getItem: (key: string) => (key === SETTINGS_KEY ? raw : null) };
}

describe("the appearance bootstrap in index.html", () => {
  it("stamps an explicit choice, and only an explicit choice", () => {
    expect(stamped(holding(JSON.stringify({ appearance: "dark" })))).toBe("dark");
    expect(stamped(holding(JSON.stringify({ appearance: "light" })))).toBe("light");
    // Alongside the other settings, which is how it actually sits in storage.
    expect(
      stamped(holding(JSON.stringify({ presenceColor: "#0675c9", appearance: "dark" }))),
    ).toBe("dark");
  });

  it("leaves the attribute off for everything that is not one", () => {
    // "system" is a choice to *not* pin one, so it is spelled the same way as
    // never having chosen: no attribute, and the media query decides.
    for (const raw of [
      JSON.stringify({ appearance: "system" }),
      JSON.stringify({ presenceColor: "#0675c9" }),
      JSON.stringify({ appearance: "DARK" }),
      JSON.stringify(["dark"]),
      JSON.stringify(null),
      "{not json at all",
      null,
    ]) {
      expect(stamped(holding(raw))).toBeNull();
    }
  });

  it("survives storage that refuses to answer", () => {
    // A private window, or a browser told to block site data: the page still
    // has to render, so the read is allowed to fail and nothing else may.
    expect(
      stamped({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeNull();
  });

  it("reads the key the settings module writes", () => {
    // The snippet cannot import anything, so the key is spelled twice in the
    // repo. This is what makes renaming it in settings.ts fail loudly here
    // instead of quietly reintroducing the flash.
    expect(bootstrapSource()).toContain(SETTINGS_KEY);
  });
});
