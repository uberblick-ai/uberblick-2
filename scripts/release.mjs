#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = "uberblick-ai/uberblick-2";
const CLIENT_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PUBLISHERS = [
  { name: "Homebrew client", workflow: "release-homebrew.yml", title: "Publish Homebrew release",
    job: "Publish payload and tap formula", step: "Publish the immutable release and generated formula" },
  { name: "hub images", workflow: "release-hub.yml", title: "Publish hub release",
    job: "publish", step: "Build, scan and publish the immutable hub version" },
];

function fail(message) {
  throw new Error(`release: ${message}`);
}

export function latestSignoff(statuses) {
  return statuses.filter((status) => status.context === "signoff")
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
}

export function releaseNotes(prs) {
  const groups = { Features: [], Fixes: [], "Breaking changes": [] };
  for (const pr of new Map(prs.map((pr) => [pr.number, pr])).values()) {
    const group = /breaking|\bbreak\b|incompatib/i.test(pr.title) ? "Breaking changes"
      : /\bfix(?:es|ed)?\b|\bbug\b|regression|repair|correct/i.test(pr.title) ? "Fixes" : "Features";
    // Titles are prose, not terminal controls or extra release-note lines.
    groups[group].push(`- ${pr.title.replace(/\p{Cc}/gu, " ")} (#${pr.number})`);
  }
  return ["Release-notes draft (PRs only; grouping is a heuristic for the maintainer to edit)",
    ...Object.entries(groups).flatMap(([name, entries]) => [`\n## ${name}`, ...(entries.length ? entries : ["- None."])])].join("\n");
}

async function checkCandidate(sha, tags, services) {
  const main = await services.fetchMain();
  if (main !== sha || await services.head() !== sha) {
    fail(`candidate ${sha} is not the freshly fetched origin/main (${main}); no tags pushed`);
  }
  const remote = await services.remoteTags();
  for (const tag of tags) if (remote.some((ref) => ref.name === tag)) {
    fail(`${tag} already exists on origin; no tags pushed`);
  }
  const signoff = latestSignoff(await services.statuses(sha));
  if (signoff?.state !== "success") {
    fail(`latest signoff for ${sha} is ${signoff?.state ?? "missing"}; no tags pushed`);
  }
  return remote;
}

async function watchPublishers(sha, tags, services) {
  const states = PUBLISHERS.map((publisher, i) => ({ ...publisher, tag: tags[i], result: null, run: null }));
  const deadline = services.now() + (services.timeoutMs ?? 60 * 60 * 1000);
  while (states.some((state) => state.result === null) && services.now() < deadline) {
    for (const state of states.filter((state) => state.result === null)) {
      try {
        const runs = await services.runs(state.tag, state.workflow, sha);
        state.run = runs.find((run) => run.headSha === sha && run.headBranch === state.tag && run.event === "push") ?? null;
        if (state.run === null || state.run.status !== "completed") continue;
        const jobs = await services.jobs(state.run);
        const publish = jobs.find((job) => job.name === state.job);
        const step = publish?.steps?.find((step) => step.name === state.step);
        if (state.run.conclusion === "success" && publish?.conclusion === "success" && step?.conclusion === "success") {
          state.result = "published";
        } else {
          state.result = `not confirmed published (run ${state.run.conclusion}; publish job ${publish?.conclusion ?? "missing"}; publisher step ${step?.conclusion ?? "missing"})`;
        }
      } catch (error) {
        state.result = `publication unknown (${error.message})`;
      }
    }
    if (states.some((state) => state.result === null)) await services.wait();
  }
  for (const state of states) {
    state.result ??= "publication unknown (timed out waiting for the tag-push run)";
    services.log(`${state.name}: ${state.result}; ${state.title} ${state.tag}: ${state.run?.url ?? "no run found"}`);
  }
  if (states.some((state) => state.result !== "published")) {
    fail(`paired publication did not succeed: ${states.map((state) => `${state.name}: ${state.result}; ${state.run?.url ?? state.tag}`).join("; ")}. Tags and published artifacts stay immutable; use a new version, never overwrite or delete them`);
  }
}

/** Tag publication is atomic; the two existing publishers are not. Never try
 * to recover one failed half by rebuilding an immutable release version. */
export async function release(tag, services) {
  if (!CLIENT_TAG.test(tag)) fail("usage: mise run release vMAJOR.MINOR.PATCH");
  const tags = [tag, `hub-${tag}`];
  const sha = await services.head();
  const remote = await checkCandidate(sha, tags, services);
  const previous = await services.previousTag(sha, remote);
  const notes = releaseNotes(await services.mergedPrs(previous, sha));
  services.log(`Candidate ${sha}; previous client release: ${previous ?? "none"}`);
  await services.withCandidate(sha, async (candidate) => {
    for (const [task, dryTag] of [["publish-homebrew-release", tags[0]], ["publish-hub-release", tags[1]]]) {
      try {
        await candidate.dryRun(task, dryTag);
      } catch (error) {
        fail(`${task} -- ${dryTag} --dry-run failed at ${sha}: ${error.message}; no tags pushed`);
      }
    }
  });
  // Builds may take minutes. Fail closed if main, signoff or either tag changed.
  const current = await checkCandidate(sha, tags, services);
  if (!current.some((ref) => /^hub-v/.test(ref.name))) {
    services.log("First hub release: a maintainer must make the GHCR hub and hub-web packages public after publication, as RELEASING.md describes. No package or organization settings are changed by this task.");
  }
  await services.pushTags(sha, tags);
  services.log(`Atomically pushed ${tags.join(" and ")} at ${sha}. Waiting for both publish workflows.`);
  await watchPublishers(sha, tags, services);
  services.log(notes);
  return { sha, tags, previous };
}

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60 * 60 * 1000,
    ...options, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", ...options.env },
  });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.signal ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

export function productionServices({ root = ROOT, command: execute = command } = {}) {
  const run = (cmd, args, options = {}) => execute(cmd, args, { cwd: root, ...options });
  const api = (path) => JSON.parse(run("gh", ["api", path, "--paginate", "--slurp"]));
  return {
    head: async () => run("git", ["rev-parse", "HEAD"]),
    fetchMain: async () => {
      run("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      return run("git", ["rev-parse", "origin/main"]);
    },
    remoteTags: async () => {
      const lines = run("git", ["ls-remote", "--tags", "origin"]).split("\n").filter(Boolean);
      const refs = new Map();
      for (const line of lines) {
        const [sha, ref] = line.split(/\s+/);
        const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
        // ls-remote lists a tag object before its peeled commit.
        refs.set(name, { name, sha });
      }
      return [...refs.values()];
    },
    statuses: async (sha) => api(`repos/${REPOSITORY}/commits/${sha}/statuses?per_page=100`).flat(),
    previousTag: async (sha, remote) => {
      const ancestors = new Set(run("git", ["rev-list", sha]).split("\n"));
      const names = remote.filter((ref) => CLIENT_TAG.test(ref.name) && ancestors.has(ref.sha)).map((ref) => ref.name);
      if (names.length === 0) return null;
      run("git", ["fetch", "--quiet", "origin", ...names.map((name) => `refs/tags/${name}:refs/tags/${name}`)]);
      // Reachability, not version sorting: choosing version order is outside this task.
      return run("git", ["describe", "--tags", "--abbrev=0", ...names.flatMap((name) => ["--match", name]), sha]);
    },
    mergedPrs: async (previous, sha) => {
      const commits = run("git", ["rev-list", previous === null ? sha : `${previous}..${sha}`]).split("\n").filter(Boolean);
      const prs = new Map();
      for (const commit of commits) {
        // Filter before text reaches this process, just as AGENTS.md requires.
        const matches = run("gh", ["api", `repos/${REPOSITORY}/commits/${commit}/pulls?per_page=100`, "--paginate", "--jq",
          '.[] | select(.merged_at != null and .base.ref == "main" and (.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR" or .user.login == "copilot-pull-request-reviewer")) | {number,title,merge_commit_sha} | @json'])
          .split("\n").filter(Boolean).map((line) => JSON.parse(line));
        for (const pr of matches) if (commits.includes(pr.merge_commit_sha)) prs.set(pr.number, pr);
      }
      return [...prs.values()].sort((a, b) => a.number - b.number);
    },
    withCandidate: async (sha, body) => {
      const scratch = mkdtempSync(join(tmpdir(), "uberblick-release-"));
      const checkout = join(scratch, "candidate");
      let added = false;
      try {
        run("git", ["worktree", "add", "--quiet", "--detach", checkout, sha]);
        added = true;
        run("mise", ["trust"], { cwd: checkout, stdio: "inherit" });
        run("mise", ["run", "install"], { cwd: checkout, stdio: "inherit" });
        await body({ dryRun: async (task, tag) => run("mise", ["run", task, "--", tag, "--dry-run"], { cwd: checkout, stdio: "inherit" }) });
      } finally {
        try {
          if (added) run("git", ["worktree", "remove", "--force", checkout]);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    },
    pushTags: async (sha, tags) => run("git", ["push", "--atomic",
      ...tags.map((tag) => `--force-with-lease=refs/tags/${tag}:`), "origin",
      ...tags.map((tag) => `${sha}:refs/tags/${tag}`)], { stdio: "inherit" }),
    runs: async (tag, workflow, sha) => JSON.parse(run("gh", ["run", "list", "--repo", REPOSITORY,
      "--workflow", workflow, "--branch", tag, "--commit", sha, "--event", "push", "--limit", "20",
      "--json", "databaseId,headSha,headBranch,event,status,conclusion,url"])),
    jobs: async (run) => api(`repos/${REPOSITORY}/actions/runs/${run.databaseId}/jobs?per_page=100`).flatMap((page) => page.jobs),
    now: () => Date.now(),
    wait: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    log: (message) => process.stdout.write(`${message}\n`),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: mise run release vMAJOR.MINOR.PATCH\n");
    process.exitCode = 1;
  } else {
    release(process.argv[2], productionServices()).catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
