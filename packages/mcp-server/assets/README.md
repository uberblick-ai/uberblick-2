The MCP server loads these static Geist Mono 400 and 600 faces, for both its
layout measurement and its WebAssembly rasterizer. Production builders embed
the files, together with `@resvg/resvg-wasm`'s wasm, in every containing bundle.

The unmodified font files come from
https://github.com/vercel/geist-font/tree/a2357c1398c81d88ff84823a2f50af3152ee8733/fonts/GeistMono/ttf.
Both use a 600-unit normal character advance in a 1000-unit em.

`LICENSE-Geist.txt` is their OFL-1.1 notice. `LICENSE-resvg.txt` is the MPL-2.0
license from https://github.com/thx/resvg-js/blob/v2.6.2/LICENSE, for the bundled
unmodified `@resvg/resvg-wasm` 2.6.2 rasterizer. Release payloads carry both notices.
