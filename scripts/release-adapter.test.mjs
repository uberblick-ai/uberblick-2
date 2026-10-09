import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { productionServices } from "./release.mjs";

function command(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options, stdio: "pipe" });
  if (result.status !== 0) throw new Error(`${cmd} failed: ${result.stderr}`);
  return result.stdout?.trim() ?? "";
}

function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), "release-adapter-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, "checkout");
  const origin = join(scratch, "origin.git");
  command("git", ["init", "--quiet", "--bare", origin]);
  command("git", ["init", "--quiet", "--initial-branch=main", root]);
  const git = (args) => command("git", args, { cwd: root });
  git(["config", "user.name", "Release fixture"]);
  git(["config", "user.email", "release@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["remote", "add", "origin", origin]);
  writeFileSync(join(root, "source.txt"), "committed candidate\n");
  git(["add", "source.txt"]);
  git(["commit", "--quiet", "-m", "candidate"]);
  git(["push", "--quiet", "origin", "main"]);
  return { root, git, sha: git(["rev-parse", "HEAD"]) };
}

test("the actual adapter builds committed files in one detached tree and cleans it on either outcome", async (t) => {
  const { root, git, sha } = fixture(t);
  writeFileSync(join(root, "source.txt"), "dirty checkout\n");
  writeFileSync(join(root, "untracked.txt"), "not in the candidate\n");
  for (const failBuild of [false, true]) {
    const candidates = [];
    const services = productionServices({ root, command: (cmd, args, options) => {
      if (cmd !== "mise") return command(cmd, args, options);
      if (args.includes("--dry-run")) {
        candidates.push(options.cwd);
        assert.notEqual(options.cwd, root);
        assert.equal(command("git", ["rev-parse", "HEAD"], { cwd: options.cwd }), sha);
        assert.equal(readFileSync(join(options.cwd, "source.txt"), "utf8"), "committed candidate\n");
        assert.equal(existsSync(join(options.cwd, "untracked.txt")), false);
        if (failBuild) throw new Error("dry-run failure");
      }
      return "";
    } });
    const build = services.withCandidate(sha, async (candidate) => {
      await candidate.dryRun("publish-homebrew-release", "v0.5.0");
      await candidate.dryRun("publish-hub-release", "hub-v0.5.0");
    });
    if (failBuild) await assert.rejects(build, /dry-run failure/);
    else await build;
    assert.equal(new Set(candidates).size, 1);
    for (const path of candidates) assert.equal(existsSync(path), false);
    assert.equal(git(["worktree", "list", "--porcelain"]).split("worktree ").length, 2);
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "dirty checkout\n");
    assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "not in the candidate\n");
  }
});

test("an actual atomic push makes both remote refs, and a raced existing tag prevents both updates", async (t) => {
  const { root, git, sha } = fixture(t);
  const services = productionServices({ root, command });
  await services.pushTags(sha, ["v0.5.0", "hub-v0.5.0"]);
  assert.deepEqual((await services.remoteTags()).map((ref) => [ref.name, ref.sha]), [["hub-v0.5.0", sha], ["v0.5.0", sha]]);
  writeFileSync(join(root, "source.txt"), "competing release\n");
  git(["commit", "--quiet", "-am", "competing"]);
  const competing = git(["rev-parse", "HEAD"]);
  git(["push", "--quiet", "origin", `${competing}:refs/tags/v0.6.0`]);
  await assert.rejects(services.pushTags(sha, ["v0.6.0", "hub-v0.6.0"]), /rejected|failed/);
  assert.equal((await services.remoteTags()).some((ref) => ref.name === "hub-v0.6.0"), false);
  assert.equal(git(["tag", "--list"]), "");
});

test("previous release discovery handles lightweight, annotated, local-only and unreachable tags", async (t) => {
  const { root, git, sha } = fixture(t);
  const services = productionServices({ root, command });
  git(["tag", "v0.4.0"]);
  git(["push", "--quiet", "origin", "v0.4.0"]);
  writeFileSync(join(root, "source.txt"), "next commit\n");
  git(["commit", "--quiet", "-am", "next"]);
  const next = git(["rev-parse", "HEAD"]);
  git(["-c", "tag.gpgsign=false", "tag", "-a", "v0.3.0", "-m", "non-monotonic version"]);
  git(["push", "--quiet", "origin", "v0.3.0"]);
  git(["tag", "v9.9.9"]);
  assert.equal(await services.previousTag(next, await services.remoteTags()), "v0.3.0");
  assert.equal(await services.previousTag(sha, await services.remoteTags()), "v0.4.0");
  assert.equal((await services.remoteTags()).find((ref) => ref.name === "v0.3.0").sha, next);
});

test("notes query each range commit's associated PRs and keep only merges in that range", async () => {
  const queries = [];
  const services = productionServices({ command: (cmd, args) => {
    if (cmd === "git") {
      assert.deepEqual(args, ["rev-list", "v0.4.0..candidate"]);
      return "merge-a\ndirect-b\nmerge-c";
    }
    assert.equal(cmd, "gh");
    queries.push(args);
    assert.ok(args.includes("--paginate") && args.includes("--slurp"));
    assert.match(args[args.indexOf("--jq") + 1], /author_association/);
    return JSON.stringify([{ number: 7, title: "Feature", merge_commit_sha: "merge-a" },
      { number: 8, title: "Older associated merge", merge_commit_sha: "before-range" }]);
  } });
  assert.deepEqual(await services.mergedPrs("v0.4.0", "candidate"), [{ number: 7, title: "Feature", merge_commit_sha: "merge-a" }]);
  assert.equal(queries.length, 3);
});
