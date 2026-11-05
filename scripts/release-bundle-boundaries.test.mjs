import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleInstallEntry } from "./build-install-payload.mjs";
import { bundleHubEntry } from "./build-hub-release-payload.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromMcp = createRequire(join(root, "packages/mcp-server/package.json"));
const { Client } = requireFromMcp("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireFromMcp("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = requireFromMcp("@modelcontextprotocol/sdk/client/streamableHttp.js");
const teamModules = new Set([
	"team", "team-config", "github-sign-in", "github-device-flow", "credentials",
	"credential-admission", "credential-renewal", "memberships", "principals",
	"github-account-lookup", "hub-claim", "workspace-promotion", "access-management", "admin-setup",
]);
const clientModules = new Set([
	"local-browser-server", "storage", "project-config", "project-binding", "workspace-registry",
	"dev-config", "device-login", "auth-store", "management-client", "init-lock", "safe-write", "remote-url",
]);

// esbuild also reports loaded modules whose runtime code was erased. Only
// bytes that contribute to the shipped output cross the release boundary.
function contributingInputs(metafile, output) {
	const emitted = Object.entries(metafile.outputs).find(([path]) => resolve(root, path) === output)?.[1];
	assert.ok(emitted, `${output} was emitted`);
	return Object.entries(emitted.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([path]) => path);
}

async function render(client, uuid, blockId) {
	const call = (format) => client.callTool({ name: "render_block", arguments: { uuid, block_id: blockId,
		...(format === undefined ? {} : { format }) } }, undefined, { timeout: 10_000 });
	const png = await call();
	assert.ok(!png.isError, JSON.stringify(png));
	assert.equal(png.structuredContent.width, 1000);
	assert.equal(png.structuredContent.drawing.status, "clean");
	const images = png.content.filter(item => item.type === "image");
	assert.equal(images.length, 1);
	assert.equal(images[0].mimeType, "image/png");
	const bytes = Buffer.from(images[0].data, "base64");
	assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	assert.equal(bytes.readUInt32BE(16), png.structuredContent.width);
	assert.equal(bytes.readUInt32BE(20), png.structuredContent.height);
	assert.ok(bytes.length > 1000, "the bundle returns a drawing rather than an empty image");
	const svg = await call("svg");
	assert.ok(!svg.isError, JSON.stringify(svg));
	assert.ok(svg.content.every(item => item.type === "text"));
	assert.match(svg.structuredContent.svg, /<svg\b/);
	assert.match(svg.structuredContent.svg, /<path\b/);
	return { png: images[0].data, svg: svg.structuredContent.svg };
}

async function smokeBundledRendering(scratch) {
	const workspace = "00000000-0000-4000-8000-000000002358";
	const grantId = "00000000-0000-4000-8000-000000002359";
	const databaseDirectory = join(scratch, "host-data");
	const database = join(databaseDirectory, createHash("sha256").update(grantId).digest("hex"), `${workspace}.sqlite`);
	const environment = { PATH: process.env.PATH ?? "", HOME: scratch, XDG_DATA_HOME: join(scratch, "data") };
	const noFetch = join(scratch, "no-fetch.mjs");
	writeFileSync(noFetch, 'globalThis.fetch = () => { throw new Error("Release rendering must not fetch assets"); };\n');
	const clientLib = join(scratch, "packages/cli/lib");
	mkdirSync(clientLib, { recursive: true });
	cpSync(join(scratch, "mcp/mcp.mjs"), join(clientLib, "mcp.mjs"));
	cpSync(join(scratch, "mcp/mcp.mjs.map"), join(clientLib, "mcp.mjs.map"));
	cpSync(join(scratch, "mcp/licenses"), join(clientLib, "licenses"), { recursive: true });
	writeFileSync(join(scratch, "packages/cli/package.json"), JSON.stringify({ version: "1.2.3", type: "module" }));
	const stdio = new Client({ name: "release-render-smoke", version: "1" });
	let stderr = "";
	const transport = new StdioClientTransport({ command: process.execPath,
		args: ["--import", noFetch, join(clientLib, "mcp.mjs")], cwd: scratch,
		env: { ...environment, WORKSPACE_ID: workspace, HUB_URL: "ws://127.0.0.1:1", UBERBLICK_DB: database }, stderr: "pipe" });
	transport.stderr.on("data", chunk => { stderr += chunk; });
	let uuid;
	let blockId;
	let expected;
	try {
		await stdio.connect(transport, { timeout: 10_000 });
		assert.equal(stdio.getServerVersion().version, "1.2.3");
		const created = await stdio.callTool({ name: "create_doc", arguments: {
			title: "Release drawing", description: "A release bundle renders without installed assets.",
			blocks: [{ type: "code", language: "ablauf", text: 'flow v0\ncolumns main\npill draft "Draft"\nbox review "Review"\nend done "Done"\ndraft --> review\nreview --> done' }],
		} }, undefined, { timeout: 10_000 });
		assert.ok(!created.isError, JSON.stringify(created));
		uuid = created.structuredContent.uuid;
		blockId = created.structuredContent.blocks[0].id;
		expected = await render(stdio, uuid, blockId);
	} catch (error) {
		error.message += `\nBundled stdio diagnostics: ${stderr}`;
		throw error;
	} finally { await stdio.close(); }

	// A relative Unix socket keeps this fixture portable when the run scratch
	// directory itself exceeds the operating system's socket-path length.
	const originalCwd = process.cwd();
	process.chdir(scratch);
	const channel = createServer(socket => {
		let input = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", chunk => {
			input += chunk;
			if (!input.includes("\n")) return;
			const request = JSON.parse(input.slice(0, input.indexOf("\n")));
			const identity = { id: "00000000-0000-4000-8000-000000002360", githubAccountId: "1234", githubUsername: "release-person" };
			const answer = request.action === "introspect"
				? { status: "positive", grantId, principal: identity.id, workspace, scope: "docs:read", expiresAt: Date.now() + 60_000 }
				: request.action === "inspect-grant"
					? { status: "active", current: request.credentialId !== undefined, hasCredential: request.credentialId !== undefined,
						now: Date.now(), identity }
					: { status: "issued", credential: { id: "00000000-0000-4000-8000-000000002361", principalId: identity.id,
						deviceId: "00000000-0000-4000-8000-000000002362",
						workspaces: [workspace], issuedAt: Date.now(), revokedAt: null, replacedAt: null,
						ceiling: { grantId, workspaceId: workspace, scope: "read-only" } } };
			socket.end(`${JSON.stringify(answer)}\n`);
		});
	});
	let host;
	let hosted;
	let closed;
	try {
		channel.listen("render.sock");
		await once(channel, "listening");
		host = spawn(process.execPath, ["--import", noFetch, join(scratch, "mcp-host/mcp-host.mjs")], { cwd: scratch,
			env: { ...environment, MCP_DATA_DIR: databaseDirectory, HUB_MCP_SOCKET: "render.sock", HUB_URL: "ws://127.0.0.1:1",
				MCP_HOST: "127.0.0.1", MCP_PORT: "0" }, stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
		closed = once(host, "close");
		let diagnostics = "";
		const port = await Promise.race([
			new Promise(resolve => host.stderr.on("data", chunk => {
				diagnostics += chunk;
				const address = diagnostics.match(/MCP host listening (\{[^\n]*\})/)?.[1];
				if (address !== undefined) resolve(JSON.parse(address).address.port);
			})),
			closed.then(result => { throw new Error(`Bundled host stopped before listening: ${result}; ${diagnostics}`); }),
		]);
		hosted = new Client({ name: "release-host-render-smoke", version: "1" });
		await hosted.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${workspace}`), {
			requestInit: { headers: { Authorization: "Bearer release-render-token" } },
		}), { timeout: 10_000 });
		assert.equal(hosted.getServerVersion().version, "1.2.3", "the hub release embeds its MCP version without a checkout manifest");
		assert.deepEqual(await render(hosted, uuid, blockId), expected,
			"the released hosted read-only grant and Homebrew MCP draw identical PNG and SVG without asset sidecars");
	} finally {
		await hosted?.close();
		if (host?.exitCode === null && host.signalCode === null) host.kill("SIGTERM");
		if (closed !== undefined) await closed;
		await new Promise(resolve => channel.close(resolve));
		process.chdir(originalCwd);
	}
}

test("the actual release bundles keep team code in the hub and client code in Homebrew", async () => {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
		`release-boundaries-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	try {
		for (const [name, entry, homebrew] of [
			["ub.mjs", "packages/cli/src/main.ts", true],
			["mcp.mjs", "packages/mcp-server/src/main.ts", true],
			["mcp-host.mjs", "packages/mcp-server/src/host-main.ts", false],
			["hub.mjs", "packages/hub/src/main.ts", false],
			["ub-hub.mjs", "packages/hub/src/operator-command.ts", false],
		]) {
			const output = join(scratch, name.replace(/\.mjs$/, ""), name);
			// Use the production builders themselves, including minification,
			// tree shaking and the portable MCP source map.
			const metafile = homebrew
				? await bundleInstallEntry(join(root, entry), output, name === "mcp.mjs")
				: await bundleHubEntry(entry, output, "1.2.3");
			const inputs = contributingInputs(metafile, output);
			if (inputs.includes("packages/mcp-server/src/tools/render-assets.ts")) {
				assert.match(readFileSync(join(dirname(output), "licenses/LICENSE-Geist.txt"), "utf8"), /SIL OPEN FONT LICENSE/);
				assert.match(readFileSync(join(dirname(output), "licenses/LICENSE-resvg.txt"), "utf8"), /Mozilla Public License Version 2.0/);
			}
			assert.ok(inputs.includes(entry), `${name} contains its actual entry point`);
			for (const input of inputs) {
				const hubModule = /^packages\/hub\/src\/([^/]+)\.ts$/.exec(input)?.[1];
				if (homebrew || name === "mcp-host.mjs") {
					assert.ok(!teamModules.has(hubModule), `${name} contains hub team module ${input}`);
					if (!homebrew) assert.doesNotMatch(input, /^packages\/(cli|web)\//, `${name} contains an unrelated client package`);
				} else {
					assert.doesNotMatch(input, /^packages\/(cli|mcp-server|web)\//,
						`${name} contains a client package`);
					assert.ok(!clientModules.has(hubModule), `${name} contains client module ${input}`);
				}
			}
			if (name === "hub.mjs") {
				assert.ok(inputs.includes("packages/hub/src/github-device-flow.ts"), "the release hub retains sign-in");
				assert.ok(inputs.includes("packages/hub/src/credential-admission.ts"), "the release hub retains team admission");
			}
			if (!homebrew && name !== "mcp-host.mjs") {
				for (const databasePath of [undefined, ""]) {
					const env = { ...process.env, HOME: scratch, XDG_DATA_HOME: join(scratch, "data") };
					delete env.HUB_DB_PATH;
					if (databasePath !== undefined) env.HUB_DB_PATH = databasePath;
					const before = readdirSync(scratch).sort();
					const result = spawnSync(process.execPath, [output,
						...(name === "ub-hub.mjs" ? ["admin-setup", "00000000-0000-4000-8000-000000001387"] : [])], {
						cwd: scratch, env, encoding: "utf8", timeout: 10_000,
					});
					assert.equal(result.error, undefined, `${name} stops without hanging`);
					assert.equal(result.status, 1, `${name} refuses HUB_DB_PATH=${JSON.stringify(databasePath)}`);
					assert.match(result.stderr, /HUB_DB_PATH/);
					assert.deepEqual(readdirSync(scratch).sort(), before, "refusal creates no fallback database or data directory");
				}
			}
			if (name === "ub-hub.mjs") {
				const alias = join(scratch, "operator-alias.mjs");
				symlinkSync(output, alias);
				const aliased = spawnSync(process.execPath, [alias, "admin-setup", "00000000-0000-4000-8000-000000001387"], {
					cwd: scratch, env: { ...process.env, HUB_DB_PATH: "" }, encoding: "utf8", timeout: 10_000,
				});
				assert.equal(aliased.status, 1, "a symlinked command executes and refuses the missing database setting");
				assert.match(aliased.stderr, /HUB_DB_PATH/);
				for (const args of [[], ["--help"]]) {
					const result = spawnSync(process.execPath, [output, ...args], {
						cwd: scratch, encoding: "utf8", timeout: 10_000,
					});
					assert.equal(result.status, 0, "the bundled operator command prints help without opening a database");
					for (const command of ["status", "doctor", "admin-setup", "backup", "restore"]) {
						assert.match(result.stdout, new RegExp(command));
					}
				}
			}
		}
		await smokeBundledRendering(scratch);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("the release builder refuses contributing test code from any package", async () => {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(), `release-test-code-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	try {
		for (const directory of ["packages/mcp-server/test", "packages/another/tests", "packages/example/src/__tests__"]) {
			mkdirSync(join(scratch, directory), { recursive: true });
			const stub = join(scratch, directory, "stub.mjs");
			writeFileSync(stub, "export function checkToken() { return 'test-only-positive'; }\n");
			const entry = join(scratch, "entry.mjs");
			writeFileSync(entry, `import {checkToken} from ${JSON.stringify(stub)}; console.log(checkToken());\n`);
			await assert.rejects(bundleHubEntry(entry, join(scratch, "mcp-host.mjs")), /release bundle contains package test code/);
		}
	} finally { rmSync(scratch, { recursive: true, force: true }); }
});
