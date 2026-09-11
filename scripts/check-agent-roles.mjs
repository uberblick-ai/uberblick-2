#!/usr/bin/env node
/** Project integration with an adopted workflow. Source portability and adapter
 * policy are checked in agent-workflows; this checks our bindings and launch
 * wiring against the declaration we adopted, without owning its role roster.
 * The immutable review image excludes Claude agents/settings and .github;
 * only those absent roots are skipped, visibly, as before.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROLES = ".agents/roles";
const LAUNCH = ".agents/launch.json";
const REQUIRES = ".agents/requires.json";
const failures = [];
const fail = (message) => failures.push(message);
const read = (relative) => readFileSync(join(root, relative), "utf8");
const object = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
const exactKeys = (value, expected) =>
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const keysWithin = (value, required, optional = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const strings = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === "string" && item.trim() !== "");
const excluded = [".claude/agents", ".claude/settings.json", ".github"];
const skipped = new Set();
function present(relative) {
  if (existsSync(join(root, relative))) return true;
  const absent = excluded.find(
    (path) =>
      (relative === path || relative.startsWith(`${path}/`)) && !existsSync(join(root, path)),
  );
  if (absent) skipped.add(absent);
  else fail(`missing declared resource: ${relative}`);
  return false;
}
function json(relative) {
  try {
    return object(JSON.parse(read(relative)));
  } catch {
    fail(`${relative}: missing or invalid JSON`);
    return null;
  }
}
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
  for (const key of required) if (!keys.get(key)) fail(`${label}: missing or empty "${key}"`);
  if (keys.has("name") && keys.get("name") !== slug)
    fail(`${label}: name is "${keys.get("name")}", expected "${slug}"`);
  for (const key of keys.keys())
    if (!allowed.includes(key)) fail(`${label}: key "${key}" pins runtime policy`);
  for (const table of tables) fail(`${label}: table "[${table}]" pins runtime policy`);
  if (!body.includes(`${ROLES}/${slug}.md`))
    fail(`${label}: does not name its contract ${ROLES}/${slug}.md`);
}

const requires = json(REQUIRES);
const launch = json(LAUNCH);
if (
  !requires ||
  !exactKeys(requires, ["version", "bindings", "resources", "projectResources"]) ||
  requires.version !== 1 ||
  !["bindings", "resources", "projectResources"].every((key) => strings(requires[key]))
) {
  fail(`${REQUIRES}: expected version 1 with bindings, resources and projectResources`);
} else {
  for (const relative of [...requires.resources, ...requires.projectResources]) present(relative);
  for (const path of requires.bindings) {
    let value = launch;
    for (const key of path.split(".")) value = object(value)?.[key];
    if (value === undefined || value === null || value === "" || typeof value === "object")
      fail(`${LAUNCH}: missing required binding ${path}`);
  }
}
const resources = new Set(requires?.resources ?? []);
const projectResources = new Set(requires?.projectResources ?? []);
const entries = object(launch?.entryRoles);
if (
  !launch ||
  !exactKeys(launch, ["version", "project", "entryRoles"]) ||
  launch.version !== 2 ||
  !object(launch.project) ||
  !entries ||
  Object.keys(entries).length === 0
) {
  fail(`${LAUNCH}: expected version 2 with project and entryRoles objects`);
} else
  for (const [slug, raw] of Object.entries(entries)) {
    const entry = object(raw);
    if (
      !entry ||
      !exactKeys(entry, ["contract", "defaultRuntime", "probe", "runtimes"]) ||
      !/^[a-z][a-z0-9-]*$/.test(slug)
    ) {
      fail(`${LAUNCH}: ${slug} has a malformed entry`);
      continue;
    }
    if (entry.contract !== `${ROLES}/${slug}.md` || !resources.has(entry.contract))
      fail(`${LAUNCH}: ${slug} contract is not its declared workflow contract`);
    if (!strings(entry.probe)) fail(`${LAUNCH}: ${slug} probe must be a non-empty argv`);
    else
      for (const argument of entry.probe)
        if (argument.includes("/") && !projectResources.has(argument))
          fail(`${LAUNCH}: ${slug} probe path ${argument} is not a declared project resource`);
    const runtimes = object(entry.runtimes);
    if (
      !runtimes ||
      !exactKeys(runtimes, ["claude", "codex"]) ||
      !Object.hasOwn(runtimes, entry.defaultRuntime)
    ) {
      fail(`${LAUNCH}: ${slug} must declare its default runtime`);
      continue;
    }
    for (const [runtime, rawConfig] of Object.entries(runtimes)) {
      const config = object(rawConfig);
      const required =
        runtime === "claude" ? ["adapter", "sandbox", "permissionMode"] : ["adapter", "sandbox"];
      if (
        !["claude", "codex"].includes(runtime) ||
        !config ||
        !keysWithin(config, required, runtime === "claude" ? ["allowedTools"] : [])
      ) {
        fail(`${LAUNCH}: ${slug} ${runtime} launch data is malformed`);
        continue;
      }
      if (
        !(runtime === "claude" ? ["runtime"] : ["workspace-write", "unsandboxed"]).includes(
          config.sandbox,
        )
      )
        fail(`${LAUNCH}: ${slug} ${runtime} has an invalid sandbox`);
      if (runtime === "claude" && config.permissionMode !== "auto")
        fail(`${LAUNCH}: ${slug} claude has an invalid permission mode`);
      if (config.allowedTools !== undefined && !strings(config.allowedTools))
        fail(`${LAUNCH}: ${slug} allowedTools must list non-empty tool names`);
      if (
        config.adapter !== `.${runtime}/agents/${slug}.${runtime === "claude" ? "md" : "toml"}` ||
        !resources.has(config.adapter)
      ) {
        fail(`${LAUNCH}: ${slug} ${runtime} adapter is not a declared workflow resource`);
        continue;
      }
      if (!present(config.adapter)) continue;
      if (runtime === "claude") {
        const front = parseFrontmatter(config.adapter, read(config.adapter));
        if (!front) fail(`${config.adapter}: missing frontmatter`);
        else
          check(
            config.adapter,
            slug,
            front.keys,
            ["name", "description"],
            ["name", "description", "isolation", "effort"],
            [],
            front.body,
          );
      } else {
        const { keys, tables } = parseToml(config.adapter, read(config.adapter));
        check(
          config.adapter,
          slug,
          keys,
          ["name", "description", "developer_instructions"],
          ["name", "description", "developer_instructions"],
          tables,
          keys.get("developer_instructions") ?? "",
        );
      }
    }
  }
// These two skills remain this project's responsibility; their protocol is adopted.
for (const relative of [
  ".agents/skills/shape-issue/SKILL.md",
  ".claude/skills/shape-issue/SKILL.md",
]) {
  if (!present(relative)) continue;
  if (!read(relative).includes(".agents/protocols/issue-shaping.md"))
    fail(`${relative}: does not point to .agents/protocols/issue-shaping.md`);
}
for (const path of skipped) console.log(`skipped: ${path} is absent from this checkout`);
if (failures.length) {
  for (const message of failures) console.error(`check-agent-roles: ${message}`);
  process.exit(1);
}
console.log(
  `check-agent-roles: project bindings, declared resources and ${Object.keys(entries ?? {}).length} launch entries`,
);
