# Security

Thanks for looking. Uberblick is built by a small team, so this page is short.

## Reporting a vulnerability

Report it privately through
[GitHub private vulnerability reporting](https://github.com/uberblick-ai/uberblick-2/security/advisories/new).
Please don't open a public issue, pull request or discussion.
If you can't use GitHub, email security@uberblick.ai.

A useful report has:

- what you found and what an attacker gains,
- the version (`ub status`, or `docker compose exec hub ub-hub status` on a hub),
- steps to reproduce, ideally against a fresh local hub (`ub open`).

## What happens next

- We confirm we have your report within 3 working days.
- Within 10 working days we tell you whether we see a vulnerability and what we plan.
- We fix it in a patch release and publish a GitHub security advisory,
  with a CVE when it qualifies. We credit you unless you'd rather we didn't.
- Please wait for the fix, or 90 days, before you publish. If we go quiet, ping the report.

## Supported versions

Only the latest release gets security fixes. Uberblick is before 1.0 and
releases often. The `ub` client and the hub image ship together under one
version number. There are no backports: updating is the fix.

## Scope

In scope is everything in this repository and the releases built from it:
the hub, the web app, the `ub` CLI, the MCP server, the Docker images,
the Compose files and the Homebrew payload. We especially want to hear about:

- reading or changing a workspace without current membership,
- a revoked device or an expired browser session that still works,
- document content that makes the MCP server reach past the workspace it
  was started for: another workspace, local files, stored credentials,
- a release file or image that holds something it shouldn't, or doesn't
  match its source commit.

Out of scope:

- An agent doing what a document told it to. The MCP server gives an agent
  read and write access to one workspace, and everyone who can edit that
  workspace can write text the agent reads. Treat workspace members as people
  who can steer your agent. We do want to hear when our server makes this
  worse than it has to be.
- Hubs run against the setup in [REMOTE.md](REMOTE.md), for example with the
  hub port published directly or plain HTTP between computers.
- Versions older than the latest release.
- Denial of service by traffic volume, and scanner output without a working impact.
- Known issues in dependencies that don't affect Uberblick.

## Good-faith research

If you follow this page, we won't take legal action against you or ask
GitHub to. Test only against a hub you run yourself, never
hub.uberblick.ai or anyone else's hub. Don't access other people's
data, and if you reach some by accident, stop and tell us.

## Running your own hub

- Run a published release on the supported setup in [REMOTE.md](REMOTE.md):
  Docker on Linux x86_64 or arm64, or Docker Desktop on macOS.
- The default serves HTTP on host loopback only. Other computers need HTTPS
  with public DNS, or the Tailscale route.
- Keep `.env` at mode 600. Backups hold every document; store them like the
  database.
- The hub doesn't update itself. Watch this repository's releases
  (Watch → Custom → Releases) and update when an advisory names your version.
- Removing someone from a workspace stops their sync but can't erase what
  they already downloaded. For a lost laptop, run
  `ub auth logout --all-devices <hub>` from another signed-in computer.
  It signs out every one of your devices, that computer last.
