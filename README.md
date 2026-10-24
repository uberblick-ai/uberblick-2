# Uberblick

A knowledge base for humans and agents alike.

The plans, decisions and numbers behind your software, in one workspace your
coding agents read before they build and keep up to date after. People review
in the browser; agents work over MCP; delivery stays on GitHub. Local-first,
synced by a hub you run.

The website, [uberblick.ai](https://uberblick.ai), is built from
[uberblick-ai/uberblick.ai](https://github.com/uberblick-ai/uberblick.ai); it
reads this repository's `CHANGELOG.md` and newest release tag at build time.

## Install

On Apple Silicon macOS or Linux x86_64, install
[Homebrew](https://brew.sh) and follow its shell setup instructions so
`brew` and the commands it installs are on PATH. Then:

```sh
brew install uberblick-ai/tap/uberblick
ub --version
```

Homebrew installs the CLI and web editor together.

## Your first ten minutes

Local only, no hub, no account. The same five steps, with the result to expect
after each one, are the guide
[Your first ten minutes](https://uberblick.ai/guides/first-ten-minutes).

### 1. Create the workspace in your project

Run this in the checkout of the product the pages will be about, not in a
notes folder:

```sh
cd ~/Projects/my-product
ub workspace create "My product"
ub open
```

`ub workspace create` creates a local workspace with two starter pages and
writes `.uberblick.json` into the directory. That binding is what later lets
an agent started in this directory find the same workspace. `ub open` opens
the editor in your browser and keeps running in this terminal; Ctrl-C stops it.
Edits are saved locally first.

### 2. Write one rule

Create a page whose title says what it is about, for example **Checkout:
rules**, and write three sentences that say what the product should do. Rules,
not tasks. Pin the page in the sidebar: pinned pages are where an agent that
has never seen the workspace starts.

### 3. Connect the agent

In a second terminal, in the same directory, with
[Claude Code](https://code.claude.com/docs/en/setup) installed:

```sh
ub mcp install claude
```

For Codex, `ub mcp install codex`. The command runs the client's own installer
and registers one server named `uberblick`; restart the client afterwards. Then
put the workspace section of the agent instructions into your `AGENTS.md` or
`CLAUDE.md`: the block on
[Agents over MCP](https://uberblick.ai/docs/agents#instructions). Its first
line is the one that matters today: start from the pinned pages when you do
not know the project.

### 4. Ask, change the page, ask again

Ask the agent a question your rule page answers, and ask it to name the page it
read. Watch the tool calls: `get_sidebar`, then `get_doc` on your page. Now
change a sentence in the browser and ask the same question again. The answer
follows the page, with no restart and no copy of the text anywhere else.

### 5. Record a decision and find it by issue

Ask the agent to record an open question as a decision, linked to an issue in
your repository, and not to decide it. Approve the record on its topic page in
the browser. In a fresh session, `find_decisions` for that issue returns it:
the answer, who decided and when. That is what keeps an agent from reopening a
settled question next month.

## Read more

- [User guide](USER_GUIDE.md): commands, MCP clients, configuration, updating and local files.
- [Contributing](CONTRIBUTING.md): source setup, development, tests and how work enters the agent workflow.
- [Security](SECURITY.md): reporting a vulnerability, scope and running your own hub safely.
- [Remote hubs](REMOTE.md): deploy a hub and share a workspace across computers.
- [License](LICENSE): license terms.
