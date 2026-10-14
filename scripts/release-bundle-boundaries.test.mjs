import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleInstallEntry } from "./build-install-payload.mjs";
import { bundleHubEntry } from "./build-hub-release-payload.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

test("the actual release bundles keep team code in the hub and client code in Homebrew", async () => {
	const scratch = mkdtempSync(join(process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
		`release-boundaries-${process.env.UB_AGENTS_RUN ?? "test"}-`));
	try {
		for (const [name, entry, homebrew] of [
			["ub.mjs", "packages/cli/src/main.ts", true],
			["mcp.mjs", "packages/mcp-server/src/main.ts", true],
			["hub.mjs", "packages/hub/src/main.ts", false],
			["ub-hub.mjs", "packages/hub/src/operator-command.ts", false],
		]) {
			const output = join(scratch, name);
			// Use the production builders themselves, including minification,
			// tree shaking and the portable MCP source map.
			const metafile = homebrew
				? await bundleInstallEntry(join(root, entry), output, name === "mcp.mjs")
				: await bundleHubEntry(entry, output);
			const inputs = contributingInputs(metafile, output);
			assert.ok(inputs.includes(entry), `${name} contains its actual entry point`);
			for (const input of inputs) {
				const hubModule = /^packages\/hub\/src\/([^/]+)\.ts$/.exec(input)?.[1];
				if (homebrew) {
					assert.ok(!teamModules.has(hubModule), `${name} contains hub team module ${input}`);
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
			if (!homebrew) {
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
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
