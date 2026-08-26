#!/usr/bin/env node
/**
 * The repository check over `docs-seed/`.
 *
 * Two failures it exists to catch, and nothing else:
 *
 * 1. **A seed file missing its identity.** The importer refuses a file with no
 *    `uuid` or no `title`, but only when somebody runs it — and it never looks
 *    at the tag at all. A seed file whose uuid is not a uuid, or whose tag is
 *    not one of the five the corpus is grouped by, imports into a document
 *    nothing can find. This says so at test time instead.
 *
 * 2. **A documented command that no longer exists.** The seed documents tell a
 *    reader to run `mise run <task>`. Deleting or renaming a task in
 *    `mise.toml` is what turns those instructions into a lie, and it is a
 *    one-word change nobody would think to grep for.
 *
 * Plain Node, `node:` imports only, no dependency on the workspace being built:
 * it is the docs' own gate and must run before anything vouches for the tree.
 * Run by the root `test` script, so `mise run test` and the Docker review both
 * execute it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SEED_DIR = join(ROOT, "docs-seed");

/** The tag vocabulary the corpus is grouped by. Exactly one per document. */
const TAGS = new Set([
  "start-here",
  "feature",
  "verify",
  "reference",
  "implementation-reference",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const failures = [];

function fail(where, message) {
  failures.push(`${where}: ${message}`);
}

/** `key: value` and `key: [a, b]` — the frontmatter spelling the seed uses. */
function frontmatter(text) {
  if (!text.startsWith("---\n")) {
    return null;
  }
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) {
    return null;
  }
  const fields = new Map();
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (match !== null) {
      fields.set(match[1], match[2].trim());
    }
  }
  return fields;
}

function list(value) {
  if (value === undefined || value === "") {
    return [];
  }
  const inner = /^\[(.*)\]$/.exec(value);
  const body = inner === null ? value : inner[1];
  return body
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// --- 1. seed metadata ------------------------------------------------------

const seedFiles = readdirSync(SEED_DIR)
  .filter((file) => file.endsWith(".md") && file !== "README.md")
  .sort();

if (seedFiles.length === 0) {
  fail("docs-seed", "no seed documents");
}

const uuids = new Map();
for (const file of seedFiles) {
  const text = readFileSync(join(SEED_DIR, file), "utf8");
  const fields = frontmatter(text);
  if (fields === null) {
    fail(file, "no frontmatter block");
    continue;
  }

  const uuid = fields.get("uuid");
  if (uuid === undefined) {
    fail(file, "no `uuid` — identity is uuids, and the importer never invents one");
  } else if (!UUID.test(uuid)) {
    fail(file, `\`uuid\` is not a lowercase uuid: ${uuid}`);
  } else if (uuids.has(uuid)) {
    fail(file, `\`uuid\` is already claimed by ${uuids.get(uuid)}`);
  } else {
    uuids.set(uuid, file);
  }

  if (fields.get("title") === undefined || fields.get("title") === "") {
    fail(file, "no `title`");
  }

  const tags = list(fields.get("tags"));
  if (tags.length !== 1) {
    fail(file, `expected exactly one tag, found ${tags.length}`);
  } else if (!TAGS.has(tags[0])) {
    fail(file, `unknown tag ${tags[0]} — expected one of ${[...TAGS].join(", ")}`);
  }
}

// Links are uuids, and a seed document may only link within the snapshot: a
// dangling link is a backlink nothing answers on a freshly imported workspace.
for (const file of seedFiles) {
  const fields = frontmatter(readFileSync(join(SEED_DIR, file), "utf8"));
  for (const link of list(fields?.get("links"))) {
    if (!UUID.test(link)) {
      fail(file, `\`links\` carries something that is not a uuid: ${link}`);
    } else if (!uuids.has(link)) {
      fail(file, `\`links\` names ${link}, which no seed document carries`);
    }
  }
}

// --- 2. documented commands ------------------------------------------------

const miseToml = readFileSync(join(ROOT, "mise.toml"), "utf8");
const tasks = new Set(
  [...miseToml.matchAll(/^\[tasks\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1]),
);

for (const file of [...seedFiles, "README.md"]) {
  const text = readFileSync(join(SEED_DIR, file), "utf8");
  // `\s+`, not a space: a seed document wraps, and `mise run\ntest` is still a
  // command the reader will type.
  for (const match of text.matchAll(/\bmise run\s+([A-Za-z0-9_-]+)/g)) {
    if (!tasks.has(match[1])) {
      fail(file, `names \`mise run ${match[1]}\`, which mise.toml does not define`);
    }
  }
}

// --- 3. the README table names every document, and only those --------------

// The table is where an issue author looks a uuid up. A row that has lost its
// document sends them to a `get_doc` that fails; a document with no row is
// invisible to anyone who does not run `list_docs` first.
const readme = readFileSync(join(SEED_DIR, "README.md"), "utf8");
const rows = new Map(
  [...readme.matchAll(/^\| (.+?) \| `([0-9a-f-]{36})` \|/gm)].map((m) => [
    m[2],
    m[1],
  ]),
);

for (const [uuid, file] of uuids) {
  const fields = frontmatter(readFileSync(join(SEED_DIR, file), "utf8"));
  const title = fields?.get("title");
  if (!rows.has(uuid)) {
    fail("README.md", `no table row for ${title} (${uuid}), which ${file} carries`);
  } else if (rows.get(uuid) !== title) {
    fail("README.md", `row for ${uuid} says "${rows.get(uuid)}", ${file} says "${title}"`);
  }
}
for (const [uuid, title] of rows) {
  if (!uuids.has(uuid)) {
    fail("README.md", `table row "${title}" (${uuid}) has no seed document`);
  }
}

// --- report ----------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(
    `docs-seed check: ${failures.length} problem${failures.length === 1 ? "" : "s"}\n`,
  );
  for (const failure of failures) {
    process.stderr.write(`  ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `docs-seed check: ${seedFiles.length} documents, ${tasks.size} mise tasks, all sound\n`,
);
