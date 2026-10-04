import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(repoRoot, "bin/corpus-mcp.sh");
const shellRoute = 'exec "$HOME/.local/bin/uberblick-corpus-mcp"';
const requiredVersion = "0.2.0-corpus.b574609";

function fixture(t) {
	const root = mkdtempSync(join(
		process.env.UB_AGENTS_SCRATCH ?? tmpdir(),
		`uberblick-corpus-mcp-${process.env.UB_AGENTS_RUN ?? "test"}-`,
	));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const client = join(root, "installed client");
	const log = join(root, "commands.log");
	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(client, `#!/bin/sh
case "$*" in
  --version)
    printf '%s\\n' version >> "$CORPUS_TEST_LOG"
    printf '%s\\n' "$CORPUS_TEST_VERSION"
    exit "$CORPUS_TEST_VERSION_EXIT"
    ;;
  'mcp serve')
    printf '%s\\n' 'mcp serve' >> "$CORPUS_TEST_LOG"
    IFS= read -r line
    printf '%s\\n' "$line"
    exit "$CORPUS_TEST_SERVE_EXIT"
    ;;
  *) exit 99 ;;
esac
`);
	chmodSync(client, 0o755);
	const trap = join(bin, "ub");
	writeFileSync(trap, `#!/bin/sh\nprintf '%s\\n' checkout >> "$CORPUS_TEST_LOG"\nexit 98\n`);
	chmodSync(trap, 0o755);
	return {
		root,
		client,
		log,
		run({ args = [], path = client, version = requiredVersion, versionExit = "0", serveExit = "0" } = {}) {
			return spawnSync("sh", [launcher, ...args], {
				cwd: root,
				encoding: "utf8",
				input: '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					UB_CORPUS_CLIENT: path,
					CORPUS_TEST_LOG: log,
					CORPUS_TEST_VERSION: version,
					CORPUS_TEST_VERSION_EXIT: versionExit,
					CORPUS_TEST_SERVE_EXIT: serveExit,
				},
			});
		},
	};
}

test("the installed client keeps stdio and exit status with a checkout ub first on PATH", (t) => {
	const current = fixture(t);
	const result = current.run({ serveExit: "23" });
	assert.equal(result.status, 23, result.stderr);
	assert.equal(result.stdout, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
	assert.equal(result.stderr, "");
	assert.equal(readFileSync(current.log, "utf8"), "version\nmcp serve\n");
});

test("check verifies the pinned client without starting MCP or reading its configuration", (t) => {
	const current = fixture(t);
	const result = current.run({ args: ["--check"] });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, `client ${current.client}\nversion ${requiredVersion}\n`);
	assert.equal(readFileSync(current.log, "utf8"), "version\n");
});

test("missing, non-executable and relative client paths refuse without falling back to PATH", (t) => {
	const current = fixture(t);
	for (const path of [join(current.root, "missing"), "ub", "./installed client"]) {
		const result = current.run({ path });
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /absolute installed client path|installed client is missing/);
	}
	chmodSync(current.client, 0o644);
	const result = current.run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /installed client is missing/);
	assert.equal(existsSync(current.log), false);
});

test("a changed or unverifiable installed version never starts MCP", (t) => {
	const current = fixture(t);
	for (const options of [
		{ version: "0.2.0" },
		{ version: "0.3.0" },
		{ version: "0.0.0" },
		{ version: `${requiredVersion}\nextra output` },
		{ versionExit: "19" },
	]) {
		const result = current.run(options);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /requires installed corpus client 0\.2\.0-corpus\.b574609|could not verify/);
	}
	assert.equal(readFileSync(current.log, "utf8"), "version\n".repeat(5));
});

test("the wrapper accepts only its check operation or the fixed MCP operation", (t) => {
	const current = fixture(t);
	for (const args of [["open"], ["mcp", "serve"], ["--check", "extra"]]) {
		const result = current.run({ args });
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /usage:/);
	}
	assert.equal(existsSync(current.log), false);
});

test("all project and worker MCP configurations use the host launcher independent of candidate cwd", () => {
	const expected = { type: "stdio", command: "sh", args: ["-c", shellRoute] };
	const json = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
	assert.deepEqual(json.mcpServers.uberblick, expected);
	const codex = readFileSync(join(repoRoot, ".codex/config.toml"), "utf8");
	assert.match(codex, /^command = "sh"$/m);
	assert.ok(codex.includes(`args = ["-c", '${shellRoute}']`));
	const workers = readFileSync(join(repoRoot, "ub-agents.yaml"), "utf8");
	const inline = workers.match(/- '(\{"mcpServers":.+\})'/);
	assert.ok(inline, "Claude worker configuration must override an older candidate's .mcp.json");
	assert.deepEqual(JSON.parse(inline[1]).mcpServers.uberblick, expected);
	assert.ok(workers.includes('mcp_servers.uberblick.command="sh"'));
	assert.ok(workers.includes(`mcp_servers.uberblick.args=["-c", ''${shellRoute}'']`));
	assert.doesNotMatch(workers, /mcp_servers\.uberblick\.command="ub"|- \.mcp\.json/);
});
