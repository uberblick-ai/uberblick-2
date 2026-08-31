/**
 * The OFL requires its text to accompany the font software wherever the font is
 * distributed — a built `dist/` included. The mechanism is `public/`, which Vite
 * copies verbatim into the build, so the license ships if and only if it sits
 * there. Deleting or moving it is a licensing regression, not a cleanup.
 *
 * This checks the source-tree inputs that cause the emission, not the build
 * output: running a real Vite build here would buy nothing the copy step can
 * fail at.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every vendored face and the OFL text that has to travel with it. Geist ships
 * as two files under one license; Fraunces is its own (#536). A face added
 * without its license, or a license deleted from under a face, is the
 * regression this defends.
 */
const bundled = [
  { woff2: "Geist-Variable.woff2", license: "LICENSE-Geist.txt" },
  { woff2: "GeistMono-Variable.woff2", license: "LICENSE-Geist.txt" },
  { woff2: "Fraunces-Variable-latin.woff2", license: "LICENSE-Fraunces.txt" },
  { woff2: "Fraunces-Variable-latin-ext.woff2", license: "LICENSE-Fraunces.txt" },
  { woff2: "Fraunces-Variable-vietnamese.woff2", license: "LICENSE-Fraunces.txt" },
];

describe("bundled fonts", () => {
  it("keep the OFL text in public/, where every build copies it from", () => {
    const vendored = readdirSync(resolve(webRoot, "src/assets/fonts"));
    expect(vendored.filter((f) => f.endsWith(".woff2")).sort()).toEqual(
      bundled.map((face) => face.woff2).sort(),
    );

    for (const { license } of bundled) {
      expect(readFileSync(resolve(webRoot, "public", license), "utf8")).toContain(
        "SIL OPEN FONT LICENSE",
      );
    }
  });
});
