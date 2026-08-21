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

describe("bundled fonts", () => {
  it("keep the OFL text in public/, where every build copies it from", () => {
    const fonts = readdirSync(resolve(webRoot, "src/assets/fonts"));
    expect(fonts.filter((f) => f.endsWith(".woff2")).length).toBeGreaterThan(0);

    const license = readFileSync(
      resolve(webRoot, "public/LICENSE-Geist.txt"),
      "utf8",
    );
    expect(license).toContain("SIL OPEN FONT LICENSE");
  });
});
