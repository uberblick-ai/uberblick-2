# Uberblick

Local-first collaborative documents for people and agents.

Uberblick is a shared workspace for notes, plans, research and decisions. You
edit documents in a web editor; agents search, read and update those same
documents through MCP. It is for people who want their own work and their
agents' work in one place, with links and a sidebar to keep useful material
close. Documents live on your computer first. A hub can sync them to other
computers and workspace members.

## Install

On Apple Silicon macOS or Linux x86_64, install
[Homebrew](https://brew.sh) and follow its shell setup instructions so
`brew` and the commands it installs are on PATH. Then:

```sh
brew install uberblick-ai/tap/uberblick
ub --version
```

Homebrew installs the CLI and web editor together.

## Open your first workspace

Start in a new directory, outside a source checkout or another bound project:

```sh
mkdir uberblick-notes
cd uberblick-notes
ub init --yes --no-mcp
ub open
```

`ub init` creates a local workspace with starter documents and writes
`.uberblick.json` for this directory. In the current release, it also creates
the local signing secret needed to start the hub.

`ub open` opens the editor in your browser and keeps running in this terminal.
Edits are saved locally first. Keep it running while you use the editor or
connect an agent; Ctrl-C stops it. Local use needs no hub deployment or login.

## Connect an agent

With [Claude Code](https://code.claude.com/docs/en/setup) installed, open another
terminal in the same `uberblick-notes` directory and run:

```sh
ub mcp install claude
```

For Codex, use `ub mcp install codex` instead, with Codex installed. Restart
the client or reload its MCP servers after installation. Your agent can then
search, read, create and edit documents in this workspace. Try asking it to
write a project plan, then open that document in the editor.

## Read more

- [User guide](USER_GUIDE.md): commands, MCP clients, configuration, updating and local files.
- [Contributing](CONTRIBUTING.md): source setup, development, tests and how work enters the agent workflow.
- [Security](SECURITY.md): private vulnerability reporting and supported deployment.
- [Remote hubs](REMOTE.md): deploy a hub and share a workspace across computers.
- [License](LICENSE): license terms.
