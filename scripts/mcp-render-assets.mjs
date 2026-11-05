import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mcp = join(root, "packages/mcp-server");
const requireFromMcp = createRequire(join(mcp, "package.json"));
const assetsModule = "packages/mcp-server/src/tools/render-assets.ts";

/** Keep the source loader useful in checkouts and the release bundle self-contained. */
export function mcpRenderAssets(version) {
	return {
		name: "mcp-render-assets",
		setup(build) {
			if (version !== undefined) {
				build.onLoad({ filter: /[/\\]mcp-server[/\\]src[/\\]version\.ts$/ }, () => ({ loader: "js",
					contents: `export function mcpVersion() { return ${JSON.stringify(version)}; }` }));
			}
			build.onLoad({ filter: /[/\\]mcp-server[/\\]src[/\\]tools[/\\]render-assets\.ts$/ }, () => {
				const wasm = readFileSync(requireFromMcp.resolve("@resvg/resvg-wasm/index_bg.wasm")).toString("base64");
				const fonts = ["GeistMono-Regular.ttf", "GeistMono-SemiBold.ttf"]
					.map(file => readFileSync(join(mcp, "assets", file)).toString("base64"));
				return {
					loader: "js",
					contents: `let assets; export function renderAssets() { return assets ??= {
						wasm: Buffer.from(${JSON.stringify(wasm)}, "base64"),
						fonts: ${JSON.stringify(fonts)}.map(font => Buffer.from(font, "base64"))
					}; }`,
				};
			});
		},
	};
}

export function writeMcpRenderNotices(metafile, destination) {
	const containsAssets = Object.values(metafile.outputs).some(output => Object.entries(output.inputs)
		.some(([path, input]) => path.replaceAll("\\", "/") === assetsModule && input.bytesInOutput > 0));
	if (!containsAssets) return;
	const licenses = join(destination, "licenses");
	mkdirSync(licenses, { recursive: true });
	for (const file of ["LICENSE-Geist.txt", "LICENSE-resvg.txt"]) {
		cpSync(join(mcp, "assets", file), join(licenses, file));
	}
}
