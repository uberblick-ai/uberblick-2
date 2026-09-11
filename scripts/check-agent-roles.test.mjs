/** Project-owned integration checks; portable source coverage lives upstream. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
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
const root = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-integration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requires = JSON.parse(readFileSync(join(root, ".agents/requires.json"), "utf8"));
  for (const relative of [
    "scripts/check-agent-roles.mjs",
    ...requires.resources,
    ...requires.projectResources,
    ".agents/skills/shape-issue/SKILL.md",
    ".claude/skills/shape-issue/SKILL.md",
  ]) {
    if (!existsSync(join(root, relative))) continue;
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    cpSync(join(root, relative), join(dir, relative));
  }
  return dir;
}
function run(dir) {
  return spawnSync(process.execPath, [join(dir, "scripts/check-agent-roles.mjs")], {
    encoding: "utf8",
  });
}
function edit(dir, path, fn) {
  const value = JSON.parse(readFileSync(join(dir, path), "utf8"));
  fn(value);
  writeFileSync(join(dir, path), JSON.stringify(value));
}
function passes(dir) {
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
}
function fails(dir, pattern) {
  const result = run(dir);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, pattern);
}
test("current adopted workflow integrates, including the review image exclusions", (t) => {
  const dir = fixture(t);
  passes(dir);
  for (const path of [".claude/agents", ".claude/settings.json", ".github"])
    rmSync(join(dir, path), { recursive: true, force: true });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /skipped: \.github/);
});
test("every declared binding and project resource is independently required", (t) => {
  const binding = fixture(t);
  edit(binding, ".agents/requires.json", (x) => x.bindings.push("project.context.additional"));
  fails(binding, /missing required binding project.context.additional/);
  const missing = fixture(t);
  edit(missing, ".agents/requires.json", (x) =>
    x.projectResources.push("scripts/missing-project-tool.sh"),
  );
  fails(missing, /missing declared resource: scripts\/missing-project-tool.sh/);
});
test("missing adopted protocols and stale project shaping adapters fail", (t) => {
  const missing = fixture(t);
  rmSync(join(missing, ".agents/protocols/issue-preparation.test.mjs"));
  fails(missing, /missing declared resource: \.agents\/protocols\/issue-preparation.test.mjs/);
  const stale = fixture(t);
  writeFileSync(join(stale, ".agents/skills/shape-issue/SKILL.md"), "Read an old protocol.");
  fails(stale, /does not point to \.agents\/protocols\/issue-shaping.md/);
});
test("launch entries bind their own adapter and declare their probe and default runtime", (t) => {
  const wrong = fixture(t);
  edit(wrong, ".agents/launch.json", (x) => {
    x.entryRoles.implementer.runtimes.codex.adapter = ".codex/agents/integrator.toml";
  });
  fails(wrong, /expected "implementer"/);
  const missing = fixture(t);
  edit(missing, ".agents/launch.json", (x) => {
    x.entryRoles.implementer.defaultRuntime = "unknown";
  });
  fails(missing, /must declare its default runtime/);
  const probe = fixture(t);
  edit(probe, ".agents/launch.json", (x) => {
    x.entryRoles.implementer.probe = ["sh", "scripts/undeclared.sh"];
  });
  fails(probe, /not a declared project resource/);
});
test("adapter syntax remains checked at the project launch boundary", (t) => {
  const dir = fixture(t);
  writeFileSync(
    join(dir, ".codex/agents/implementer.toml"),
    'name = "implementer"\ndescription = "valid" trailing\n',
  );
  fails(dir, /value is not one quoted string/);
});
test("role roster, default runtime and valid project launch policy are data", (t) => {
  const dir = fixture(t);
  edit(dir, ".agents/launch.json", (x) => {
    delete x.entryRoles.integrator;
    x.entryRoles.implementer.defaultRuntime = "claude";
    x.entryRoles.implementer.runtimes.codex.sandbox = "workspace-write";
    x.entryRoles.implementer.runtimes.claude.permissionMode = "default";
  });
  passes(dir);
  // A new workflow-provided role can be launched without editing the checker.
  const slug = "custom-role";
  const paths = [`.agents/roles/${slug}.md`, `.codex/agents/${slug}.toml`];
  writeFileSync(join(dir, paths[0]), "# Custom role\n");
  writeFileSync(
    join(dir, paths[1]),
    `name = "${slug}"\ndescription = "Custom"\ndeveloper_instructions = "Read ${paths[0]}"\n`,
  );
  edit(dir, ".agents/requires.json", (x) => x.resources.push(...paths));
  edit(dir, ".agents/launch.json", (x) => {
    x.entryRoles[slug] = {
      contract: paths[0],
      defaultRuntime: "codex",
      probe: ["true"],
      runtimes: { codex: { adapter: paths[1], sandbox: "read-only" } },
    };
  });
  passes(dir);
});
