# Project instructions

Read [AGENTS.md](AGENTS.md). It is the shared entry point for every runtime.

The workflow files covered by `.agents/workflow.lock.json` are adopted from
[agent-workflows](https://github.com/uberblick-ai/agent-workflows). Propose changes
to those files in that source repository, then bring a reviewed version here
with an explicit `ub agents update <source>` and commit the resulting diff.
Do not author workflow changes in this consumer repository. Project-owned
launch data, settings, skills, audits and integration checks remain here.
