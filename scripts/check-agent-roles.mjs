#!/usr/bin/env node
/**
 * The six agent roles, checked for portability — nothing more.
 *
 * A role is a triplet: the contract at `.agents/roles/<slug>.md` and two thin
 * adapters that point a runtime at it. This proves the triplets exist, that all
 * three agree on identity, that each adapter parses as its runtime's format and
 * names the exact contract, and that none pins runtime policy — model, tools,
 * permissions, sandbox and MCP configuration belong to the runtime and the
 * invoker, never to a checked-in description.
 *
 * It deliberately does not check the contracts' prose: no headings, no required
 * sentences, no uuids, no wording. Encoding editorial rules here would make the
 * documents harder to improve and turn every clarification into a build break.
 * The placeholder scan is the exception, and structure too. A green run says
 * nothing about whether a runtime discovers these files or reads a contract.
 *
 * Plain Node, no imports beyond `node:`, like `fue-assert.mjs` beside it.
 * `.claude/agents` is absent from the immutable review image (`.dockerignore`
 * re-admits only `.claude/skills/**`, and the runner builds with main's copy),
 * so that third is skipped loudly there; CI, on a plain checkout, enforces it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SLUGS = ["issue-preparer", "issue-adversary", "implementer",
	"implementation-reviewer", "integrator", "program-coordinator"];

const ROLES = ".agents/roles";
const CLAUDE = ".claude/agents";
const CODEX = ".codex/agents";

/** Anything outside these would pin policy the runtime and invoker own. */
const CLAUDE_REQUIRED = ["name", "description"];
const CLAUDE_ALLOWED = [...CLAUDE_REQUIRED, "isolation"];
const CODEX_ALLOWED = ["name", "description", "developer_instructions"];

const PLACEHOLDERS = /\b(TODO|TBD|FIXME|XXX)\b|lorem/i;

const failures = [];
const fail = (message) => failures.push(message);
const read = (relative) => readFileSync(join(root, relative), "utf8");
const listFiles = (relative) =>
	readdirSync(join(root, relative), { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);

/** `---` fenced frontmatter, one `key: value` per line. */
function parseFrontmatter(text) {
	const lines = text.split("\n");
	const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
	if (end === -1) return null;
	const keys = new Map();
	for (const line of lines.slice(1, end)) {
		const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (pair) keys.set(pair[1], pair[2].trim().replace(/^["'](.*)["']$/, "$1"));
	}
	return keys;
}

/** `key = "…"` and `key = """…"""`, plus any table headers present. */
function parseToml(text) {
	const keys = new Map();
	const tables = [];
	let open = null;
	let buffer = [];
	for (const line of text.split("\n")) {
		if (open !== null) {
			const end = line.indexOf('"""');
			if (end === -1) buffer.push(line);
			else {
				keys.set(open, [...buffer, line.slice(0, end)].join("\n").trim());
				open = null;
			}
			continue;
		}
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const header = trimmed.match(/^\[+([^\]]+)\]+$/);
		if (header) tables.push(header[1]);
		const pair = header ? null : trimmed.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
		if (!pair) continue;
		if (pair[2].startsWith('"""') && !pair[2].slice(3).endsWith('"""')) {
			open = pair[1];
			buffer = [pair[2].slice(3)];
		} else keys.set(pair[1], pair[2].replace(/^"+(.*?)"+$/s, "$1").trim());
	}
	return { keys, tables };
}

/** Identity, required keys, no policy pins, and the exact contract pointer. */
function check(label, slug, keys, required, allowed, tables, body) {
	for (const key of required)
		if (!keys.get(key)) fail(`${label}: missing or empty "${key}"`);
	if (keys.has("name") && keys.get("name") !== slug)
		fail(`${label}: name is "${keys.get("name")}", expected "${slug}"`);
	for (const key of keys.keys())
		if (!allowed.includes(key)) fail(`${label}: key "${key}" pins runtime policy`);
	for (const table of tables)
		fail(`${label}: table "[${table}]" pins runtime policy`);
	if (!body.includes(`${ROLES}/${slug}.md`))
		fail(`${label}: does not name its contract ${ROLES}/${slug}.md`);
}

const claudePresent = existsSync(join(root, CLAUDE));
if (!claudePresent)
	console.log(`skipped: ${CLAUDE} is absent from this checkout, so the Claude adapters cannot be checked here`);

const expected = [...SLUGS].sort();
const contracts = listFiles(ROLES)
	.filter((name) => name.endsWith(".md") && name !== "README.md")
	.map((name) => name.slice(0, -3))
	.sort();
if (contracts.join(",") !== expected.join(","))
	fail(`${ROLES}: holds [${contracts.join(", ")}], expected exactly [${expected.join(", ")}]`);

for (const slug of SLUGS) {
	const claudePath = `${CLAUDE}/${slug}.md`;
	if (claudePresent && !existsSync(join(root, claudePath)))
		fail(`${claudePath}: missing`);
	else if (claudePresent) {
		const text = read(claudePath);
		const keys = parseFrontmatter(text);
		// `isolation` is permitted but optional, so it is not in the required set.
		if (!keys) fail(`${claudePath}: no "---" frontmatter block`);
		else check(claudePath, slug, keys, CLAUDE_REQUIRED, CLAUDE_ALLOWED, [], text);
	}

	const codexPath = `${CODEX}/${slug}.toml`;
	if (!existsSync(join(root, codexPath))) {
		fail(`${codexPath}: missing`);
		continue;
	}
	const { keys, tables } = parseToml(read(codexPath));
	const body = keys.get("developer_instructions") ?? "";
	check(codexPath, slug, keys, CODEX_ALLOWED, CODEX_ALLOWED, tables, body);
}

let scanned = 0;
for (const dir of claudePresent ? [ROLES, CLAUDE, CODEX] : [ROLES, CODEX])
	for (const name of listFiles(dir)) {
		scanned++;
		const found = read(join(dir, name)).match(PLACEHOLDERS);
		if (found) fail(`${dir}/${name}: unfinished placeholder "${found[0]}"`);
	}

if (failures.length > 0) {
	for (const message of failures) console.error(`check-agent-roles: ${message}`);
	process.exit(1);
}

console.log(`check-agent-roles: ${SLUGS.length} roles, ${scanned} files, structure only.`);
