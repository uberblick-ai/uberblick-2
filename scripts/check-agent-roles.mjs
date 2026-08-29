#!/usr/bin/env node
/**
 * The six agent roles, checked as structure — nothing more.
 *
 * Each role is a triplet: the canonical contract at `.agents/roles/<slug>.md`
 * plus two thin adapters, `.claude/agents/<slug>.md` and
 * `.codex/agents/<slug>.toml`, whose only job is to send a runtime to that
 * contract before it does anything. This script proves the triplets exist, that
 * the three files agree on identity and description, that the adapters pin no
 * runtime policy and carry the read-or-stop instruction, and that each contract
 * still holds its headings, the corpus uuid and the pending-migration sentence.
 *
 * What it cannot prove: that a runtime discovers these files, that an agent
 * reads its contract, or that a line of the prose is true. This is a static
 * check of file structure, and a green run is not evidence of runtime behavior.
 *
 * Plain Node with no imports beyond `node:`, like `fue-assert.mjs` beside it: a
 * check that guards the agent workflow should not depend on an install.
 *
 * `.claude/agents` is absent from the immutable review image — `.dockerignore`
 * excludes `.claude` and re-admits only `.claude/skills/**`, and the review
 * runner always builds with main's copy of it. That third is therefore skipped
 * loudly there rather than failing; CI, on a plain checkout, enforces it.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SLUGS = [
	"issue-preparer",
	"issue-adversary",
	"implementer",
	"implementation-reviewer",
	"integrator",
	"program-coordinator",
];

const ROLES = ".agents/roles";
const CLAUDE = ".claude/agents";
const CODEX = ".codex/agents";

/** General Agent Workflow — the corpus document every contract cites. */
const HUB_UUID = "c0bb016d-3d4c-4316-9b4e-da8a7b322e55";

const MARKER =
	"#460's broader authority model is pending repository migration: " +
	"`AGENTS.md`, `CLAUDE.md` and `.github/ISSUE_SPEC.md` win on conflicts; " +
	"installing these descriptions starts no worker and grants no merge authority.";

const HEADINGS = [
	"## Input",
	"## Product context",
	"## Outcome",
	"## Prohibited adjacent work",
	"## Completion record",
	"## Stop",
	"## Authority",
];

/** Frontmatter keys a Claude adapter may carry — anything else pins policy. */
const CLAUDE_ALLOWED = ["name", "description", "isolation"];
/** Required and permitted at once: a Codex adapter carries these three keys, no
 * other top-level key, and no table — every one of those pins runtime policy. */
const CODEX_ALLOWED = ["name", "description", "developer_instructions"];

/** Words that turn a discoverable description into an activation instruction. */
const DENYLIST = [
	"proactively",
	"automatically",
	"must be used",
	"without being asked",
	"on every",
	"continuously",
];

const PLACEHOLDERS = /\b(TODO|TBD|FIXME|XXX)\b|lorem/i;

const failures = [];
const fail = (message) => failures.push(message);
const flat = (text) => text.replace(/\s+/g, " ").trim();
const read = (relative) => readFileSync(join(root, relative), "utf8");
const listFiles = (relative) =>
	readdirSync(join(root, relative), { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);

/** `---` fenced frontmatter, one `key: value` per line. */
function parseFrontmatter(text) {
	const lines = text.split("\n");
	if (lines[0] !== "---") return null;
	const end = lines.indexOf("---", 1);
	if (end === -1) return null;
	const keys = new Map();
	for (const line of lines.slice(1, end)) {
		const pair = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (pair) keys.set(pair[1], pair[2].trim().replace(/^["'](.*)["']$/, "$1"));
	}
	return keys;
}

/** Top-level `key = "…"` and `key = """…"""`, plus the table names present. */
function parseToml(text) {
	const lines = text.split("\n");
	const keys = new Map();
	const tables = [];
	let table = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) continue;
		const header = line.match(/^\[+([^\]]+)\]+$/);
		if (header) {
			table = header[1];
			tables.push(table);
			continue;
		}
		const pair = line.match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
		if (!pair) continue;
		let value = pair[2];
		if (value.startsWith('"""')) {
			const rest = value.slice(3);
			if (rest.endsWith('"""')) {
				value = rest.slice(0, -3);
			} else {
				const parts = [rest];
				while (++i < lines.length && !lines[i].includes('"""'))
					parts.push(lines[i]);
				if (i < lines.length)
					parts.push(lines[i].slice(0, lines[i].indexOf('"""')));
				value = parts.join("\n");
			}
		} else {
			value = value.replace(/^"(.*)"$/, "$1");
		}
		if (table === "") keys.set(pair[1], value.trim());
	}
	return { keys, tables };
}

/** The read-or-stop instruction all twelve adapters carry, word for word. */
function checkAdapterBody(label, slug, body) {
	const instruction = `\`${ROLES}/${slug}.md\` in full before any side effect`;
	const text = flat(body);
	if (!text.includes(instruction))
		fail(`${label}: missing the literal instruction ${instruction}`);
	if (!text.includes("cannot be read, stop"))
		fail(`${label}: does not stop when the contract cannot be read`);
}

function checkDescription(label, description) {
	if (!description) {
		fail(`${label}: description is empty`);
		return;
	}
	for (const word of DENYLIST)
		if (description.toLowerCase().includes(word))
			fail(`${label}: description contains activation language "${word}"`);
}

const claudePresent = existsSync(join(root, CLAUDE));
if (!claudePresent)
	console.log(
		`skipped: ${CLAUDE} is absent from this checkout, so the Claude adapters cannot be checked here`,
	);

// The contract directory holds exactly the six roles, plus its own README.
const contracts = listFiles(ROLES)
	.filter((name) => name.endsWith(".md") && name !== "README.md")
	.map((name) => name.slice(0, -3))
	.sort();
const expected = [...SLUGS].sort();
if (contracts.join(",") !== expected.join(","))
	fail(
		`${ROLES}: holds [${contracts.join(", ")}], expected exactly [${expected.join(", ")}]`,
	);
if (!existsSync(join(root, ROLES, "README.md")))
	fail(`${ROLES}/README.md: missing shared guidance`);

for (const slug of SLUGS) {
	const contractPath = `${ROLES}/${slug}.md`;
	const codexPath = `${CODEX}/${slug}.toml`;
	const claudePath = `${CLAUDE}/${slug}.md`;

	let claudeDescription = null;

	if (!existsSync(join(root, contractPath))) {
		fail(`${contractPath}: missing`);
	} else {
		const contract = read(contractPath);
		const lines = contract.split("\n");
		if (!/^# \S/.test(lines[0] ?? ""))
			fail(`${contractPath}: does not open with a "# <Role name>" heading`);
		for (const heading of HEADINGS)
			if (!lines.includes(heading))
				fail(`${contractPath}: missing heading "${heading}"`);
		if (!contract.includes(HUB_UUID))
			fail(`${contractPath}: does not link its corpus document by uuid`);
		if (!flat(contract).includes(flat(MARKER)))
			fail(`${contractPath}: missing the pending-migration sentence`);
	}

	if (claudePresent) {
		if (!existsSync(join(root, claudePath))) {
			fail(`${claudePath}: missing`);
		} else {
			const text = read(claudePath);
			const keys = parseFrontmatter(text);
			if (!keys) {
				fail(`${claudePath}: no "---" frontmatter block`);
			} else {
				if (keys.get("name") !== slug)
					fail(`${claudePath}: name is "${keys.get("name")}", expected "${slug}"`);
				claudeDescription = keys.get("description") ?? "";
				checkDescription(claudePath, claudeDescription);
				for (const key of keys.keys())
					if (!CLAUDE_ALLOWED.includes(key))
						fail(`${claudePath}: frontmatter key "${key}" pins runtime policy`);
				const isolation = keys.get("isolation");
				if (slug === "implementer") {
					if (isolation !== "worktree")
						fail(`${claudePath}: implementer needs "isolation: worktree"`);
				} else if (isolation !== undefined) {
					fail(`${claudePath}: only the implementer declares isolation`);
				}
				checkAdapterBody(claudePath, slug, text.slice(text.indexOf("---", 3)));
			}
		}
	}

	if (!existsSync(join(root, codexPath))) {
		fail(`${codexPath}: missing`);
		continue;
	}
	const { keys, tables } = parseToml(read(codexPath));
	for (const key of CODEX_ALLOWED)
		if (!keys.get(key)) fail(`${codexPath}: missing or empty "${key}"`);
	if (keys.has("name") && keys.get("name") !== slug)
		fail(`${codexPath}: name is "${keys.get("name")}", expected "${slug}"`);
	for (const key of keys.keys())
		if (!CODEX_ALLOWED.includes(key))
			fail(`${codexPath}: key "${key}" pins runtime policy`);
	for (const table of tables)
		fail(`${codexPath}: table "[${table}]" pins runtime policy`);
	const description = keys.get("description") ?? "";
	checkDescription(codexPath, description);
	if (claudeDescription !== null && claudeDescription !== description)
		fail(`${codexPath}: description differs from ${claudePath}`);
	checkAdapterBody(codexPath, slug, keys.get("developer_instructions") ?? "");
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

console.log(
	`check-agent-roles: ${SLUGS.length} roles, ${scanned} files, static structure only.`,
);
