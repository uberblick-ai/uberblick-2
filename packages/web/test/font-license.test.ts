/**
 * The OFL requires the license text to accompany the font software wherever it
 * is distributed — a built `dist/` included. Vite emits only the assets
 * something references, so the license ships if and only if a reference to it
 * survives in `index.html`. Deleting that link is a licensing regression, not a
 * cleanup, hence the guard.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fontsDir = resolve(webRoot, "src/assets/fonts");

describe("bundled fonts", () => {
  it("ship an OFL license that the build emits", () => {
    const fonts = readdirSync(fontsDir).filter((f) => f.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);

    const license = readFileSync(resolve(fontsDir, "LICENSE.txt"), "utf8");
    expect(license).toContain("SIL OPEN FONT LICENSE");

    const html = readFileSync(resolve(webRoot, "index.html"), "utf8");
    expect(html).toContain('href="/src/assets/fonts/LICENSE.txt"');
  });
});
