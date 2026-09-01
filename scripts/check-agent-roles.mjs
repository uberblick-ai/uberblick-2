#!/usr/bin/env node
/**
 * The six agent roles and issue-authoring adapters, checked for portability.
 *
 * A role is a triplet: the contract at `.agents/roles/<slug>.md` and two thin
 * adapters that point a runtime at it. This proves the triplets exist, that all
 * three agree on identity, that each adapter parses as its runtime's format and
 * names the exact contract, and that none pins runtime policy — except the
 * owner-approved `effort: high` pins on issue-preparer and implementer from
 * directive 438df7d, whose value is checked where the key is present and whose
 * presence is not required. Model, tools, permissions, sandbox and MCP
 * configuration belong to the runtime and the invoker, never to a checked-in
 * description.
 *
 * It deliberately does not check the contracts' or protocols' prose: no
 * headings, required sentences, uuids, product judgments or readiness rules.
 * Encoding editorial rules here would make the documents harder to improve and
 * turn every clarification into a build break. Structure is all it checks, and
 * a green run says nothing about whether a runtime discovers these files or
 * reads a contract.
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
const ISSUE_SHAPING = ".agents/protocols/issue-shaping.md";
const ISSUE_PREPARATION = [
	".agents/protocols/issue-preparation.md",
	".agents/protocols/issue-preparation.mjs",
	".agents/protocols/issue-preparation.test.mjs",
];
const CLAUDE_SKILLS = ".claude/skills";
const CLAUDE_SHAPING_ADAPTER = ".claude/skills/shape-issue/SKILL.md";
const SHAPING_ADAPTERS = [
	".agents/skills/shape-issue/SKILL.md",
	".agents/adapters/chatgpt-voice.md",
];

/** Anything outside these would pin policy the runtime and invoker own. */
const CLAUDE_REQUIRED = ["name", "description"];
const CLAUDE_ALLOWED = [...CLAUDE_REQUIRED, "isolation"];
const CLAUDE_APPROVED_EFFORT = new Map([
	["issue-preparer", "high"],
	["implementer", "high"],
]);
const CODEX_ALLOWED = ["name", "description", "developer_instructions"];

const failures = [];
const fail = (message) => failures.push(message);
const read = (relative) => readFileSync(join(root, relative), "utf8");
const listFiles = (relative) =>
	readdirSync(join(root, relative), { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);

/** `---` fenced frontmatter, one `key: value` per line, and the body after it. */
function parseFrontmatter(label, text) {
	const lines = text.split("\n");
	const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
	if (end === -1) return null;
	const keys = new Map();
	for (const line of lines.slice(1, end)) {
		const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (pair) keys.set(pair[1], pair[2].trim().replace(/^["'](.*)["']$/, "$1"));
		else if (line.trim() !== "")
			fail(`${label}: frontmatter line is not "key: value": ${line.trim()}`);
	}
	return { keys, body: lines.slice(end + 1).join("\n") };
}

/** One complete quoted value, then nothing but an optional comment. */
const QUOTED = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/;
/** What may follow a closing `"""`: whitespace or a comment, nothing else. */
const AFTER_CLOSE = /^\s*(?:#.*)?$/;

/** `key = "…"` and `key = """…"""`, plus any table headers present. */
function parseToml(label, text) {
	const keys = new Map();
	const tables = [];
	let open = null;
	let buffer = [];
	for (const line of text.split("\n")) {
		if (open !== null) {
			const end = line.indexOf('"""');
			if (end === -1) buffer.push(line);
			else {
				if (!AFTER_CLOSE.test(line.slice(end + 3)))
					fail(`${label}: text after the closing """: ${line.trim()}`);
				keys.set(open, [...buffer, line.slice(0, end)].join("\n").trim());
				open = null;
			}
			continue;
		}
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const header = trimmed.match(/^\[+([^\]]+)\]+$/);
		if (header) {
			tables.push(header[1]);
			continue;
		}
		const pair = trimmed.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
		const value = pair?.[2] ?? "";
		if (!value.startsWith('"'))
			fail(`${label}: not a quoted "key = value" or a table header: ${trimmed}`);
		else if (value.startsWith('"""')) {
			const close = value.indexOf('"""', 3);
			if (close === -1) {
				open = pair[1];
				buffer = [value.slice(3)];
			} else if (!AFTER_CLOSE.test(value.slice(close + 3)))
				fail(`${label}: text after the closing """: ${trimmed}`);
			else keys.set(pair[1], value.slice(3, close).trim());
		} else {
			const quoted = value.match(QUOTED);
			if (!quoted) fail(`${label}: value is not one quoted string: ${trimmed}`);
			else keys.set(pair[1], quoted[1].trim());
		}
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

const claudeSkillsPresent = existsSync(join(root, CLAUDE_SKILLS));
if (!claudeSkillsPresent)
	console.log(`skipped: ${CLAUDE_SKILLS} is absent from this checkout, so the Claude shaping adapter cannot be checked here`);

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
		const front = parseFrontmatter(claudePath, read(claudePath));
		// `isolation` is permitted but optional, so it is not in the required set.
		if (!front) fail(`${claudePath}: no "---" frontmatter block`);
		else {
			const approvedEffort = CLAUDE_APPROVED_EFFORT.get(slug);
			const allowed = approvedEffort
				? [...CLAUDE_ALLOWED, "effort"]
				: CLAUDE_ALLOWED;
			check(claudePath, slug, front.keys, CLAUDE_REQUIRED, allowed, [], front.body);
			if (approvedEffort && front.keys.has("effort") && front.keys.get("effort") !== approvedEffort)
				fail(`${claudePath}: effort is "${front.keys.get("effort")}", expected owner-approved "${approvedEffort}"`);
		}
	}

	const codexPath = `${CODEX}/${slug}.toml`;
	if (!existsSync(join(root, codexPath))) {
		fail(`${codexPath}: missing`);
		continue;
	}
	const { keys, tables } = parseToml(codexPath, read(codexPath));
	const body = keys.get("developer_instructions") ?? "";
	check(codexPath, slug, keys, CODEX_ALLOWED, CODEX_ALLOWED, tables, body);
}

for (const relative of [ISSUE_SHAPING, ...ISSUE_PREPARATION]) {
	if (!existsSync(join(root, relative))) fail(`${relative}: missing provider-neutral issue-authoring file`);
}

for (const relative of [
	...SHAPING_ADAPTERS,
	...(claudeSkillsPresent ? [CLAUDE_SHAPING_ADAPTER] : []),
]) {
	if (!existsSync(join(root, relative))) {
		fail(`${relative}: missing issue-shaping adapter`);
		continue;
	}
	if (!read(relative).includes(ISSUE_SHAPING))
		fail(`${relative}: does not point to ${ISSUE_SHAPING}`);
}

if (failures.length > 0) {
	for (const message of failures) console.error(`check-agent-roles: ${message}`);
	process.exit(1);
}

console.log(`check-agent-roles: ${SLUGS.length} roles and issue-authoring wiring, structure only.`);
