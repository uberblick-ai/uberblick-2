#!/usr/bin/env node
/**
 * Resolve one binding the adopting project declared in `.agents/launch.json`.
 *
 * The delivery workflow in `.agents/` carries no repository slug, base ref,
 * discussion, owner handle, corpus uuid or validation command of its own. Every
 * such value is the adopting project's, declared once in its launch data, and
 * this is how a role or a helper reads one:
 *
 *     node scripts/agent-binding.mjs project.repository
 *
 * It prints the value and nothing else, so a shell can capture it. When the
 * binding is absent, empty or not a single value, it writes one line naming the
 * binding and the file and key it searched, and exits 1 — which is why a role
 * resolves a binding *before* the operation that needs it: the cost of a
 * missing binding is then a message rather than a side effect against the wrong
 * repository. Nothing here falls back to another project's values.
 *
 * The project is the checkout this script sits in, so a session running in its
 * own worktree reads that worktree's launch data. Plain Node, no imports beyond
 * `node:`, like the other helpers beside it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "usage: agent-binding.mjs <binding.path>";
/**
 * Dotted path from the launch-data root: `project.retrospectives.implementation`.
 *
 * The same grammar the launcher holds every declared binding name to, so a name
 * that survives launch validation can always be resolved here.
 */
const BINDING = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*$/;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const relative = ".agents/launch.json";
const path = join(root, relative);

const [binding, ...rest] = process.argv.slice(2);
if (binding === undefined || rest.length > 0 || !BINDING.test(binding)) {
	process.stderr.write(`${usage}\n`);
	process.exit(2);
}

function fail(message) {
	process.stderr.write(`agent-binding: ${message}\n`);
	process.exit(1);
}

let launch;
try {
	launch = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
	fail(`${path} is missing or invalid JSON (${error instanceof Error ? error.message : String(error)})`);
}

const keys = binding.split(".");
let value = launch;
let reached = "";
for (const key of keys) {
	const container =
		typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
	if (container === null || !Object.hasOwn(container, key)) {
		fail(
			`no "${binding}" binding in ${path}: ${reached === "" ? "the document" : `"${reached}"`}` +
				` declares no "${key}"`,
		);
	}
	value = container[key];
	reached = reached === "" ? key : `${reached}.${key}`;
}

if (typeof value === "object" && value !== null) {
	const named = Array.isArray(value) ? "a list" : `a group of ${Object.keys(value).join(", ")}`;
	fail(`"${binding}" in ${path} is ${named}, not one value; name the binding you need`);
}
if (value === null || value === "" || (typeof value === "number" && !Number.isFinite(value))) {
	fail(`"${binding}" in ${path} declares no usable value`);
}

process.stdout.write(`${value}\n`);
