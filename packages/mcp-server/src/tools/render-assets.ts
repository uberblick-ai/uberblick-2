import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let assets: { wasm: Uint8Array; fonts: Uint8Array[] } | undefined;

/** Release builders replace this module with the same bytes embedded in the bundle. */
export function renderAssets(): { wasm: Uint8Array; fonts: Uint8Array[] } {
  assets ??= {
    wasm: readFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm")),
    fonts: [
      readFileSync(new URL("../../assets/GeistMono-Regular.ttf", import.meta.url)),
      readFileSync(new URL("../../assets/GeistMono-SemiBold.ttf", import.meta.url)),
    ],
  };
  return assets;
}
