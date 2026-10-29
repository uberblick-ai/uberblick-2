# Uberblick

**A knowledge base for humans and agents alike.**

[![Release](https://img.shields.io/github/v/release/uberblick-ai/homebrew-tap?label=release)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![MCP: Claude Code · Codex](https://img.shields.io/badge/MCP-Claude%20Code%20%C2%B7%20Codex-6e56cf)](https://uberblick.ai/docs/agents)
[![Website](https://img.shields.io/badge/web-uberblick.ai-222)](https://uberblick.ai)

Your coding agent has some context: a `CLAUDE.md`, memory files, the plan it
drafted with you last week. But that context is gathered on each developer's
machine. It is not synced, nobody reviews it, and it goes out of date. The
agent on your laptop and the one on your colleague's work from different
pictures, and a question settled in one session gets reopened in the next.

Uberblick gives that context one shared home. Plans, rules, decisions and
numbers sit in one workspace: people review them in the browser, agents read
and edit them over MCP. The agent reads the pages its change needs before it builds and
brings them up to date after. Delivery stays on GitHub.

Free and MIT licensed. Local-first, no account to start, synced by a hub you
run when the team needs one. Built by a small team in Berlin that ships its own
software with coding agents, and used every day to build Uberblick itself.

## Before and after

You ask: *should sync retry a failed request a third time?*

**Without Uberblick**, the agent greps, finds a retry loop with no limit, and
offers to make the limit configurable. The answer you agreed in May is in a
chat log on somebody's laptop, so nobody mentions it.

**With Uberblick**, the agent asks the workspace first:

```text
▸ find_decisions  my-org/my-product#142    1 record in force
▸ get_doc         Sync: retry and backoff

No. "Retry limit on sync" was decided on 14 May: two retries, then report
the failure. The page still says "until the timeout", so I'll change the
code and that paragraph in the same pull request.
```

Two small reads instead of the whole docs folder, and the settled question
stays settled.

## What's inside

Notion meets Jupyter meets Obsidian, optimized for MCP: built for humans and
agents alike.

- **Pages that hold the product.** Markdown with blocks for tables, charts on
  real data, [ablauf](https://github.com/uberblick-ai/ablauf) flow diagrams,
  wireframes, Figma frames, callouts, JSON trees and GitHub pills. Agents
  write them in a few lines; people see them rendered next to the reasoning.
- **Decision records.** A question, a proposed answer, and the answer in force
  with who decided and when, linked to issues and pages. `find_decisions`
  returns it in one call.
- **Guidance for agents.** Pinned pages and guidance tags tell an agent that
  has never seen the project where to start, so it reads three pages instead
  of fifty.
- **Comments where the text is.** People and agents in the same thread, with
  @mentions for people and documents.
- **History.** On a hub, every revision is kept and compared side by side,
  with named states ("Reviewed by legal") and restore.
- **Files you own.** One SQLite file per workspace on your computer. It works
  offline, has no telemetry, and exports any page to Markdown.

## What it isn't

Uberblick does not track tasks. There are no boards, sprints or burndown
charts. Issues, pull requests, labels and Actions stay on GitHub, and Uberblick
holds the pages those issues point at. If you also want agents to run the
delivery loop on GitHub, that is [ub-agents](https://agents.uberblick.ai).

It is not a hosted service either. To share a workspace you run a small hub
yourself; see [Remote hubs](REMOTE.md).

## Who it's for

Small product teams and startups that build with coding agents: a few
engineers, maybe a product person, and Claude Code or Codex doing much of the
typing. If your context is spread across a Notion space, a docs folder nobody
reads and chat logs on individual laptops, Uberblick puts it in one place that
both sides can use.

## How it works

`ub open` serves the editor from your computer, and `ub mcp serve` gives your
agent the same workspace over a local MCP server. Both work on a local replica,
so reading a dozen pages costs a dozen local calls, not a dozen round trips.
Edits merge as CRDTs, so a person and an agent can change the same page at once
and nothing is lost.

The MCP server is opinionated about context. When an agent connects, it names
the few guidance pages. The decisions linked to an issue come with one call,
and search finds the rest. The agent gets what its change needs and nothing
more.

A `.uberblick.json` in your repository binds the checkout to its workspace, so
an agent started there always finds the right one. A hub syncs that workspace
across computers and team members, with GitHub sign-in.

## Install

On Apple Silicon macOS or Linux x86_64, with [Homebrew](https://brew.sh):

```sh
brew install uberblick-ai/tap/uberblick
```

That installs the `ub` CLI and the web editor. Then connect your agent in your
project's directory, once it has a workspace (step 1 below):

**Claude Code**

```sh
ub mcp install claude
```

**Codex**

```sh
ub mcp install codex
```

For another MCP client, `ub mcp install <client> --print` prints the entry to
add yourself. Restart the client afterwards.

<details>
<summary>Verify the download's build provenance</summary>

With the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`),
replace `X.Y.Z` with the release version:

```sh
curl -fL -o uberblick-X.Y.Z.tar.gz https://github.com/uberblick-ai/homebrew-tap/releases/download/vX.Y.Z/uberblick-X.Y.Z.tar.gz
gh attestation verify uberblick-X.Y.Z.tar.gz \
  --repo uberblick-ai/uberblick-2 \
  --signer-workflow uberblick-ai/uberblick-2/.github/workflows/release-homebrew.yml \
  --source-ref refs/tags/vX.Y.Z
```

This checks that the payload was built by this repository's Homebrew release
workflow from the release tag. New releases carry these attestations; releases
published before their introduction are not backfilled. See the
[verification options](https://cli.github.com/manual/gh_attestation_verify).

</details>

## Your first ten minutes

Local only: no hub, no account. The guide
[Your first ten minutes](https://uberblick.ai/guides/first-ten-minutes) walks
through the same steps with the result to expect after each one.

**1. Create the workspace in your project.** Run it in the checkout of the
product the pages will be about, not in a notes folder:

```sh
cd ~/Projects/my-product
ub workspace create "My product"
ub open
```

This creates a local workspace with two starter pages, writes
`.uberblick.json` into the directory and opens the editor in your browser.
`ub open` keeps running in the terminal; Ctrl-C stops it.

**2. Write one rule.** Create a page such as **Checkout: rules** with three
sentences on what the product should do. Rules, not tasks. Pin it in the
sidebar: pinned pages are where a new agent starts.

**3. Connect the agent.** In a second terminal in the same directory, run
`ub mcp install claude` (or `codex`) and restart the client. Add the workspace
section from [Agents over MCP](https://uberblick.ai/docs/agents#instructions)
to your `AGENTS.md` or `CLAUDE.md`.

**4. Ask, change the page, ask again.** Ask the agent a question your rule page
answers and have it name the page it read. You will see `get_sidebar`, then
`get_doc`. Change a sentence in the browser and ask again: the answer follows
the page, with no restart.

**5. Record a decision.** Ask the agent to record an open question as a
decision with a proposed answer, linked to an issue, and not to decide it.
Review it, then tell the agent: "I accept this proposal. My name is [your
name]. Record my answer as decided now, with this conversation as its source."
In a fresh session, `find_decisions` for that issue returns the answer in
force, who decided and when.

## Commands

| Command | What it does |
| --- | --- |
| `ub workspace create "<name>"` | Create a local workspace and bind this directory to it |
| `ub open` | Serve the editor and open it in your browser |
| `ub mcp install claude` | Register Uberblick with Claude Code (or `codex`) |
| `ub status` | Show the bound workspace, local storage and sync state |
| `ub workspace use <link\|id>` | Bind this directory to an existing or shared workspace |
| `ub auth login` | Sign in to the workspace's hub |
| `ub data get` / `ub data update` | Read or write the records behind a chart |
| `ub update` | Update the Homebrew installation |

`ub <command> --help` lists every option. The [user guide](USER_GUIDE.md) has
the full reference.

## FAQ

**What does it cost?** Nothing. Client and hub are MIT licensed. Running a hub
costs you a small machine.

**What leaves my machine?** With a local-only workspace, nothing. With a hub,
your documents go to that hub and to the other members' computers, encrypted
in transit. Sign-in uses GitHub's device flow, and Uberblick has no telemetry.

**Do I need a hub?** Not to start. A local-only workspace is complete on its
own. Add a hub when a second computer or a second person needs the workspace;
see [Remote hubs](REMOTE.md).

**Can I use it without agents?** Yes, as a document editor with offline sync.
But it is designed around agents writing most of the text and people reviewing
it, and guidance pages, decision records and chart data only pay off with
agents.

**Does it run on Windows?** Not natively. The Linux build may run under WSL,
but we have not tested it.

More answers in the [FAQ on uberblick.ai](https://uberblick.ai/docs/faq).

## Read more

- [User guide](USER_GUIDE.md): commands, MCP clients, configuration, updating and local files.
- [Remote hubs](REMOTE.md): deploy a hub and share a workspace across computers.
- [Contributing](CONTRIBUTING.md): source setup, development, tests and how work enters the agent workflow.
- [Security](SECURITY.md): reporting a vulnerability, scope and running your own hub safely.
- [Motivation](https://uberblick.ai/docs/motivation): why we built it.

The website, [uberblick.ai](https://uberblick.ai), is built from
[uberblick-ai/uberblick.ai](https://github.com/uberblick-ai/uberblick.ai); it
reads this repository's `CHANGELOG.md` and newest release tag at build time.

## License

[MIT](LICENSE).
