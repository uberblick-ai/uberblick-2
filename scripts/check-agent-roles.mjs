#!/usr/bin/env node
/**
 * The five agent roles, adapters and entry-role launch map, checked for portability.
 *
 * A role is a triplet: the contract at `.agents/roles/<slug>.md` and two thin
 * adapters that point a runtime at it. This proves the triplets exist, that all
 * three agree on identity, that each adapter parses as its runtime's format and
 * names the exact contract, and that adapters do not pin runtime policy — except the
 * owner-approved `effort: high` pins on issue-preparer and implementer from
 * directive 438df7d, whose value is checked where the key is present and whose
 * presence is not required. The owner-approved launch map separately names the
 * entry-role defaults, Codex sandbox modes and Claude's headless permission
 * mode; other model, tool, permission,
 * sandbox and MCP configuration belongs to the runtime and invoker, never to
 * an adapter description.
 *
 * It deliberately does not check the contracts' or protocols' prose: no
 * headings, required sentences, product judgments or readiness rules.
 * Encoding editorial rules here would make the documents harder to improve and
 * turn every clarification into a build break. Structure is all it checks, and
 * a green run says nothing about whether a runtime discovers these files or
 * reads a contract.
 *
 * The one thing it does read prose for is portability, because that property
 * cannot survive as a one-time cleanup. `.agents/` is a workflow any project
 * can adopt, so no file of it may carry this repository's slug, base ref,
 * discussion, owner handle, corpus uuid or build command; each such value is
 * declared in this project's own `.agents/launch.json` and resolved at use.
 * `.agents/requires.json` states which bindings and resources the workflow
 * needs, and this file holds the two sides together: every declared binding
 * resolves here, every declared resource exists, every portable file is
 * declared, and a helper an instruction names but the declaration omits fails
 * here rather than in whatever project adopts it next. `.agents/audits/` and
 * `.agents/skills/` are deliberately outside that portable set — they are this
 * project's own and keep their literals.
 *
 * Plain Node, no imports beyond `node:`, like `fue-assert.mjs` beside it.
 * `.claude/agents` and `.github` are absent from the immutable review image
 * (`.dockerignore` re-admits only `.claude/skills/**`, and the runner builds
 * with main's copy), so their checks are skipped loudly there; CI, on a plain
 * checkout, enforces them.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SLUGS = ["issue-preparer", "issue-adversary", "implementer",
	"implementation-reviewer", "integrator"];
const ENTRY_SLUGS = ["issue-preparer", "implementer", "implementation-reviewer",
	"integrator"];

const ROLES = ".agents/roles";
const LAUNCH = ".agents/launch.json";
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
const object = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
const exactKeys = (value, expected) =>
	Object.keys(value).sort().join(",") === [...expected].sort().join(",");

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

const REQUIRES = ".agents/requires.json";
/** `.agents/` is the portable source, minus what this project keeps for itself. */
const PROJECT_OWN = [".agents/audits/", ".agents/skills/", LAUNCH];
/** Where a portable instruction may name a file, so both sides can be compared. */
const NAMED_PATH = /(?:\.agents|\.github|\.claude|\.codex|scripts|packages|docs)\/[A-Za-z0-9._/-]+/g;
const NAMED_FILE = /(?<![\w./-])[A-Za-z][A-Za-z0-9._-]*\.(?:md|mjs|json|sh|toml)(?![\w-])/g;
/**
 * The literals a portable file may not carry, each with what to do instead.
 *
 * Narrow on purpose: a pattern here fails a build, so each one matches a value
 * that is unmistakably one project's — never ordinary prose about a concept.
 */
const FORBIDDEN = [
	[/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
		"a corpus document uuid; bind it under project.context and resolve it"],
	[/github\.com\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*/,
		"a repository or discussion URL; bind project.repository or project.retrospectives"],
	// The bare slug is the form that actually leaked: `gh -R <owner>/<repo>` and
	// `gh api repos/<owner>/<repo>/…`. Matched at the operand rather than
	// anywhere, so `-R "$REPO"`, `--repo` in prose and `repos/{owner}/{repo}`
	// stay legal and `and/or` is never a repository.
	[/(?:^|[\s`'"(])((?:-R|--repo)[ =][A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)/,
		"a repository operand; resolve project.repository and pass that"],
	[/\brepos\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*/,
		"a repository in an API path; resolve project.repository and interpolate it"],
	[/\buberblick-ai\/uberblick-2\b/,
		"this project's repository; resolve project.repository"],
	[/\borigin\/[A-Za-z0-9]/, "a base ref; bind project.baseRef and resolve it"],
	[/\bgit fetch origin main\b/, "a base ref; bind project.baseRef and resolve it"],
	// Prose only: `@param` and its kin are documentation tags, not mentions.
	[/(?:^|[\s(`])(@[A-Za-z0-9][\w-]*)/, "an account handle; bind project.owner", ".md"],
	[/\bEditorial contract\b/, "a product-document title; bind its uuid under project.context", ".md"],
	[/\b(?:mise|fnox|pnpm|npm|yarn|cargo|bazel|gradle|docker)\b/i,
		"a build or validation command; bind it under project.commands"],
	// An adopting project's roles work in their own worktree; an absolute host
	// path would send one into the checkout this workflow was copied from.
	[/(?:^|[\s"'(])\/(?:home|Users|mnt|opt|srv|var)\//,
		"an absolute host path; a role works in its own project's worktree"],
];

/** Every file of the portable source this repository ships. */
function portableFiles() {
	const found = [];
	const walk = (relative) => {
		for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
			const child = `${relative}/${entry.name}`;
			if (PROJECT_OWN.some((own) => child === own || child.startsWith(own))) continue;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) found.push(child);
		}
	};
	walk(".agents");
	for (const [directory, extension] of [[CLAUDE, ".md"], [CODEX, ".toml"]]) {
		if (!existsSync(join(root, directory))) continue;
		found.push(...listFiles(directory).filter((name) => name.endsWith(extension)).map((name) => `${directory}/${name}`));
	}
	return found;
}

/** Resolve one dotted binding path in the launch data, or null. */
function binding(launch, path) {
	let value = launch;
	for (const key of path.split(".")) {
		const container = object(value);
		if (container === null || !Object.hasOwn(container, key)) return null;
		value = container[key];
	}
	if (object(value) !== null || Array.isArray(value)) return null;
	return value === "" || value === null || value === undefined ? null : value;
}

/** The declared bindings resolve, the declared resources exist, and neither side drifts. */
function checkPortableSource() {
	let requires = null;
	try {
		requires = object(JSON.parse(read(REQUIRES)));
	} catch {
		fail(`${REQUIRES}: missing or invalid JSON`);
		return;
	}
	if (!requires || !exactKeys(requires, ["version", "bindings", "resources", "projectResources"]) || requires.version !== 1) {
		fail(`${REQUIRES}: expected only version 1, bindings, resources and projectResources`);
		return;
	}
	const lists = {};
	for (const name of ["bindings", "resources", "projectResources"]) {
		const value = requires[name];
		if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) {
			fail(`${REQUIRES}: ${name} must list non-empty strings`);
			return;
		}
		if (JSON.stringify(value) !== JSON.stringify([...new Set(value)].sort())) {
			fail(`${REQUIRES}: ${name} must be sorted and free of duplicates`);
		}
		lists[name] = value;
	}

	let launch = null;
	try {
		launch = object(JSON.parse(read(LAUNCH)));
	} catch {
		launch = null;
	}
	if (launch === null) fail(`${LAUNCH}: cannot read this project's own bindings`);
	else {
		for (const path of lists.bindings) {
			if (binding(launch, path) === null)
				fail(`${LAUNCH}: declares no "${path}", which ${REQUIRES} requires of every project`);
		}
	}

	const reviewExcluded = [CLAUDE, ".github"];
	const skipped = new Set();
	for (const relative of [...lists.resources, ...lists.projectResources]) {
		if (existsSync(join(root, relative))) continue;
		const excluded = reviewExcluded.find(
			(directory) => relative.startsWith(`${directory}/`) && !existsSync(join(root, directory)),
		);
		if (excluded) skipped.add(excluded);
		else fail(`${REQUIRES}: names a file this repository does not have: ${relative}`);
	}
	for (const directory of skipped)
		console.log(`skipped: ${directory} is absent from this checkout, so its declared resources cannot be checked here`);
	const declared = new Set([...lists.resources, ...lists.projectResources]);
	const entries = object(launch?.entryRoles);
	for (const [role, entry] of Object.entries(entries ?? {})) {
		const probe = object(entry)?.probe;
		if (!Array.isArray(probe)) continue;
		for (const argument of probe) {
			if (typeof argument !== "string" || !argument.includes("/")) continue;
			if (!lists.projectResources.includes(argument))
				fail(`${REQUIRES}: projectResources omits ${role} project probe ${argument}`);
		}
	}
	for (const relative of portableFiles()) {
		if (!lists.resources.includes(relative))
			fail(`${REQUIRES}: resources omits the portable file ${relative}`);
	}

	// Both directions of the parity that keeps an adoption complete: what an
	// instruction tells an agent to run must travel with the instruction.
	for (const relative of lists.resources) {
		let text;
		try {
			text = read(relative);
		} catch {
			continue;
		}
		const named = new Set();
		for (const match of text.match(NAMED_PATH) ?? []) named.add(match.replace(/[.,;:)`'"]+$/, ""));
		for (const match of text.match(NAMED_FILE) ?? []) {
			for (const candidate of [`${dirname(relative)}/${match}`, match]) {
				if (existsSync(join(root, candidate))) {
					named.add(candidate.replace(/^\.\//, ""));
					break;
				}
			}
		}
		for (const path of named) {
			if (declared.has(path)) continue;
			let file = false;
			try {
				file = statSync(join(root, path)).isFile();
			} catch {}
			if (file) fail(`${relative}: names ${path}, which ${REQUIRES} does not declare`);
		}
		for (const [pattern, instead, only] of FORBIDDEN) {
			if (only !== undefined && !relative.endsWith(only)) continue;
			const found = text.match(pattern);
			// The capture, where a pattern needs one to skip a leading delimiter,
			// so the message names the value rather than the quote before it.
			if (found) fail(`${relative}: carries ${JSON.stringify((found[1] ?? found[0]).trim())} — ${instead}`);
		}
	}
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

if (!existsSync(join(root, LAUNCH))) fail(`${LAUNCH}: missing repository launch data`);
else {
	let launch = null;
	try {
		launch = object(JSON.parse(read(LAUNCH)));
	} catch {
		fail(`${LAUNCH}: invalid JSON`);
	}
	const entries = object(launch?.entryRoles);
	if (launch && (!exactKeys(launch, ["version", "project", "entryRoles"]) || launch.version !== 1))
		fail(`${LAUNCH}: expected only version 1, project and entryRoles`);
	if (!entries) fail(`${LAUNCH}: entryRoles must be an object`);
	else {
		const names = Object.keys(entries).sort();
		if (names.join(",") !== [...ENTRY_SLUGS].sort().join(","))
			fail(`${LAUNCH}: holds [${names.join(", ")}], expected entry roles [${ENTRY_SLUGS.join(", ")}]`);
		for (const slug of ENTRY_SLUGS) {
			const entry = object(entries[slug]);
			const runtimes = object(entry?.runtimes);
			if (!entry || !exactKeys(entry, ["contract", "defaultRuntime", "probe", "runtimes"])) {
				fail(`${LAUNCH}: ${slug} has a malformed entry`);
				continue;
			}
			if (entry.contract !== `${ROLES}/${slug}.md`)
				fail(`${LAUNCH}: ${slug} contract is ${JSON.stringify(entry.contract)}, expected ${ROLES}/${slug}.md`);
			const expectedDefault = slug === "implementer" ? "codex" : "claude";
			if (entry.defaultRuntime !== expectedDefault)
				fail(`${LAUNCH}: ${slug} defaultRuntime is ${JSON.stringify(entry.defaultRuntime)}, expected ${expectedDefault}`);
			if (JSON.stringify(entry.probe) !== JSON.stringify(["sh", "scripts/probe-work.sh", slug]))
				fail(`${LAUNCH}: ${slug} probe does not name the repository probe and role`);
			if (!runtimes || !exactKeys(runtimes, ["claude", "codex"])) {
				fail(`${LAUNCH}: ${slug} must declare claude and codex runtimes`);
				continue;
			}
			for (const runtime of ["claude", "codex"]) {
				const config = object(runtimes[runtime]);
				const extension = runtime === "claude" ? "md" : "toml";
				const expectedAdapter = `.${runtime}/agents/${slug}.${extension}`;
				const expectedSandbox = runtime === "claude"
					? "runtime"
					: slug === "implementer" ? "unsandboxed" : "workspace-write";
				const expectedKeys = runtime === "claude"
					? ["adapter", "sandbox", "permissionMode"]
					: ["adapter", "sandbox"];
				if (!config || !exactKeys(config, expectedKeys)) {
					fail(`${LAUNCH}: ${slug} ${runtime} launch data is malformed`);
					continue;
				}
				if (config.adapter !== expectedAdapter)
					fail(`${LAUNCH}: ${slug} ${runtime} adapter is ${JSON.stringify(config.adapter)}, expected ${expectedAdapter}`);
				if (config.sandbox !== expectedSandbox)
					fail(`${LAUNCH}: ${slug} ${runtime} sandbox is ${JSON.stringify(config.sandbox)}, expected ${expectedSandbox}`);
				if (runtime === "claude" && config.permissionMode !== "auto")
					fail(`${LAUNCH}: ${slug} claude permissionMode is ${JSON.stringify(config.permissionMode)}, expected auto`);
			}
		}
	}
}

for (const relative of [ISSUE_SHAPING, ...ISSUE_PREPARATION]) {
	if (!existsSync(join(root, relative))) fail(`${relative}: missing provider-neutral issue-authoring file`);
}

checkPortableSource();

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

console.log(
	`check-agent-roles: ${SLUGS.length} roles, ${ENTRY_SLUGS.length} launch entries, issue-authoring wiring ` +
		"and the portable source against its declared bindings and resources.",
);
