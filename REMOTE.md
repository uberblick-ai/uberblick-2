# Docker hub deployment

Run a published hub release with Docker on Linux x86_64 or Docker Desktop on
macOS. Apple Silicon Macs run the published `linux/amd64` images under emulation.
The host needs no repository checkout, build tools, `ub`, GitHub account or
registry login. One version supplies the hub image, the prebuilt web image and
all host files. By default Caddy serves plain HTTP only on the host's loopback
interface at `http://localhost:8080`, answering only `localhost` and `127.0.0.1`
Host names to prevent DNS rebinding. Other computers use HTTPS for a configured
host name. Tailscale is the recommended optional network layer; public DNS is
also supported. Caddy serves the app and `/uberblick-config.json` and proxies
`/ws` and `/auth/*` to the hub. The hub is not published directly.

> Remote sync admits only device credentials with current workspace membership. Run `ub auth login` on each computer and unattended agent host, then use the MCP server or `ub open`. The host's web page receives no credential and shows no documents: direct browser sign-in is not available yet. A signing secret left in an old `.env` grants no access. Revocation stops live sync but cannot erase data already downloaded.

The access-control boundary and broader-access requirements are described in
the corpus Configuration and auth (62c70b7c-6e4c-40a4-a6bb-a7edbee08360).

## Host prerequisites

Check these before deploying:

- **Linux x86_64 with Docker Engine 28.0.0 or newer, or Docker Desktop on macOS
  with an Engine meeting that floor; Docker Compose 2.24.4 or newer.**
  Only `linux/amd64` images are published; Apple Silicon uses emulation.
  Compose 5 satisfies the floor too. `docker version --format '{{.Server.Version}}'`
  checks the Engine. Older engines can expose localhost-published ports to
  [other hosts on the same network segment](https://docs.docker.com/engine/network/port-publishing/).
  `docker compose version --short` checks the plugin; `docker info` checks that
  your host user can reach the daemon. If the Docker socket refuses access,
  Linux users may need their host's `docker` group and a new session; on macOS,
  start Docker Desktop.
- **A free TCP port on the selected interface.** The default is
  `127.0.0.1:8080`; `LOOPBACK_PORT` changes the port. An HTTPS route uses port
  443. Docker binds it before Caddy starts; an address-in-use error is reported
  by the daemon, so empty Caddy logs do not diagnose it.
- **An operator session on the host**, locally or over SSH. Tailscale SSH is
  sufficient. The operator deliberately launches and updates the stack; no
  timer, webhook or polling loop does it. Use `ssh -t` for setup cancellation
  through Ctrl-C.

No Tailscale setting, daemon or socket is needed for the default or public DNS
route. The optional Tailscale route needs a Linux host's daemon and standard
`/var/run/tailscale/tailscaled.sock`; only that route mounts the socket and runs
Caddy as root to reach it. See [the route settings below](#choose-how-clients-reach-the-hub).
The macOS routes are loopback and public DNS HTTPS; the host-socket Tailscale
recipe is Linux-only. Every other process runs in the published containers, including backup,
restore and first-admin setup. The host needs no Node, pnpm or `sqlite3`.

## Stand it up from a release

Choose an existing published hub version explicitly. The version below is an
example, not a moving channel. Run these commands **on the hub host**, in an
empty deployment directory:

```sh
mkdir -p ~/uberblick-remote
cd ~/uberblick-remote
HUB_VERSION=0.1.0
docker pull --platform linux/amd64 "ghcr.io/uberblick-ai/hub:$HUB_VERSION"
release_container=$(docker create --platform linux/amd64 "ghcr.io/uberblick-ai/hub:$HUB_VERSION")
docker cp "$release_container:/release/." .
docker rm "$release_container"
cp remote.env.example .env
chmod 600 .env
```

`docker create` does not start the container. The copied files include the
version's `docker-compose.yml`, `remote.https.yml`, `remote.tailscale.yml`, `remote.env.example` template,
`remote-settings.sh`, operator commands in `bin/`, this manual, RELEASING.md and
`release.json`. The Compose file names both exact versioned images; it has
no host build. The same prebuilt web image serves every host, with its endpoint
and workspace list supplied only by `/uberblick-config.json`.

Leave the network settings commented for same-computer use. Choose other
settings from [the guide below](#configure-and-check-the-stack), then:

```sh
sh bin/remote-compose.sh config --quiet
sh bin/remote-compose.sh pull
sh bin/remote-compose.sh up --detach
sh bin/remote-compose.sh ps
sh bin/remote-compose.sh logs --tail=100 hub caddy
```

[Check the site and WebSocket upgrade](#check-the-deployment) on the host, then
[claim the fresh hub](#claim-a-fresh-hub) with `ub auth login http://localhost:8080`.
Do this before enabling wider access. A private Tailscale route can also be
claimed before wider exposure. Confirm that the completed login reports the
claim and the default workspace's UUID. Startup creates that workspace once,
with the name **Default workspace**, and changes no computer's workspace
binding. Existing deployments keep
[host-only first-admin setup](#establish-a-workspaces-first-administrator).
Bind clients explicitly as described
[below](#binding-a-computer-to-this-hubs-workspace).

### Read a release's identity

Anyone who can pull the public image can read its source commit and sync
protocol version, without access to this repository:

```sh
docker run --rm --platform linux/amd64 --entrypoint cat "ghcr.io/uberblick-ai/hub:$HUB_VERSION" \
  /release/release.json
```

The JSON records `version`, `sourceCommit`, `syncProtocolVersion` and the two
`images` references. Both images also carry version, source revision and
protocol metadata as image labels. Client release numbers and hub release
numbers are independent; matching protocol versions decide wire compatibility,
not matching package version strings.

### Updating the host — deliberately

**The host does not update itself.** Name a newer published hub version, extract
its host files to a staging directory, inspect its identity, then replace the
release files and pull and recreate the containers. Keep the deployment's
`.env`; no release contains that file. Run one operator session at a time:

```sh
cd ~/uberblick-remote
HUB_VERSION=0.2.0
mkdir ".release-$HUB_VERSION"
docker pull --platform linux/amd64 "ghcr.io/uberblick-ai/hub:$HUB_VERSION"
release_container=$(docker create --platform linux/amd64 "ghcr.io/uberblick-ai/hub:$HUB_VERSION")
docker cp "$release_container:/release/." ".release-$HUB_VERSION/"
docker rm "$release_container"
cat ".release-$HUB_VERSION/release.json"
cp -R ".release-$HUB_VERSION/." .
sh bin/remote-compose.sh config --quiet
sh bin/remote-compose.sh pull
sh bin/remote-compose.sh up --detach --force-recreate
```

If the previous release had its operator scripts at the top level, remove
only those four leftover files after the new `bin/` commands work:

```sh
rm -f remote-compose.sh hub-backup.sh hub-restore.sh hub-admin-setup.sh
```

This cleanup is for a release directory. A compatibility checkout keeps its
root `remote-compose.sh` forwarder for older installed clients and an updater
already running across the move.

Check the selected site and `/ws` again. An existing Tailscale `.env` keeps
working without edits: the wrapper selects the HTTPS and socket files from
`TAILSCALE_HOST` and `TAILSCALE_IP`, preserving its sole Tailscale port binding.
The project remains `uberblick-remote`, and its
`hub-data`, `caddy-data` and `caddy-config` volumes keep documents, private access
records and Caddy's certificate state across replacement. Do not pass
`--volumes` to `down`, rename the project or change these volume names.
Nothing follows `latest`, a moving branch or a schedule.

**When to update:** choose a release containing a change you want live, and
stay present to verify it. Deploying a release neither creates, moves nor
deletes a workspace on existing hub data. A database holding any hub data when
this version first opens it gets no default workspace and is never claimable.

**The wire-semantics rule.** A change to what travels over the socket — the auth
token's shape or claims, the sync protocol, the room key, the served
`/uberblick-config.json` contract — requires a matching client release. Such a
hub release is published together with that client release. Move the host to
the new hub release and update all clients in the **same sitting**, and reload
every open browser tab so it takes its bundle and configuration from the host.
If you cannot finish both halves now, do neither now. Check the protocol
version recorded by the hub release before choosing it.

### Upgrade an existing deployment to device credentials

Use this procedure when the operator chooses to upgrade that deployment. A
source checkout advancing or a candidate passing acceptance does not authorize
an existing hub upgrade. To try a candidate first, use the
[isolated candidate procedure below](#try-a-candidate-on-a-fresh-isolated-hub).

Prepare the old deployment before switching either side:

1. Configure GitHub sign-in on the existing hub (the public Uberblick Login app
   is the standalone default).
2. Run host-only first-admin setup for each existing workspace, retaining its UUID.
3. Run `ub auth login <hub-origin>` on **every** computer and unattended agent
   host that syncs here. Confirm access, or allow renewal to pick up a later grant.
4. Update the hub and all clients to the matching protocol in one sitting. Restart
   MCP servers and `ub open` processes, and reload host-served pages.

There is no compatibility window or shared-secret fallback. A pre-switch client
against a switched hub says to update the client. A switched client against a
pre-switch hub says to update the hub; restart that process after updating.
Neither reading says the secret is wrong.

An upgraded machine that has not signed in keeps its local documents and
unacknowledged edits. MCP and `ub open` serve them and report **not shared with
hub**, with `ub auth login` as the action. After sign-in with workspace access,
those pending edits reach the hub using the existing binding; do not re-join,
re-create or discard them. Missing membership names the administrator and
renewal detects a later grant with the existing login.

Host-opened browsers, including phones and tablets, have no document access
until direct web sign-in is available. The supported browser route is
`ub auth login` followed by `ub open` on a computer. Revocation and membership
removal stop live sync but cannot erase downloaded data or local edits.

### Keep an existing installation while testing a candidate

Keep each corpus connection on an explicitly installed, compatible client whose
files live outside the source checkout. The selected package must preserve both
the existing hub's protocol and the corpus tools the delivery workflow uses;
finding an older executable on PATH does not prove either. For an existing
`ub open`, use that same explicit installed client. Leave the existing hub, bindings, credentials, local stores
and running workers alone.

Record the installed package identity and the executable that the actual MCP
launcher starts on each relevant host. A remaining host-side installation or
pin check is an operational handoff, not completed isolation. Candidate
acceptance uses a different hub and entirely fresh client state below; a later
attended upgrade of the existing installation uses the coordinated procedure
above.

### Try a candidate on a fresh, isolated hub

This attended rehearsal leaves existing hubs, client state and running MCP
servers alone. Build the hub and its matching client from one reviewed full
commit. Both run on a new Docker network: the hub binds `0.0.0.0:1234` inside
its container, and the client dials `ws://candidate-hub:1234`. No host port is
published. The hub's non-loopback bind requires device authentication. A
released hub keeps that admission even when Docker publishes its proxy on
host loopback.

Start a separate Bash session in a repository checkout. Set `candidate_sha` to
the exact reviewed candidate, then run the following. Keep this shell open
until the rehearsal ends; its exit trap removes only the resources it names.
An agent run uses its private scratch and run id. An attended operator session
can use its own temporary-directory root.

```bash
set -euo pipefail
candidate_sha='<full-reviewed-commit>'
git cat-file -e "$candidate_sha^{commit}"
test "$(git rev-parse "$candidate_sha^{commit}")" = "$candidate_sha"
candidate_root=$(mktemp -d "${UB_AGENTS_SCRATCH:-${TMPDIR:-$PWD}}/uberblick-candidate-${UB_AGENTS_RUN:-attended}-XXXXXXXX")
candidate_id=$(basename "$candidate_root")
candidate_network="$candidate_id-network"
candidate_hub="$candidate_id-hub"
candidate_hub_data="$candidate_id-hub-data"
candidate_writer="$candidate_id-writer"
candidate_reader="$candidate_id-reader"
candidate_tag="uberblick-candidate:$candidate_sha"

candidate_cleanup() {
  docker rm --force "$candidate_hub" "$candidate_writer-command" "$candidate_reader-command" \
    "$candidate_writer-mcp" "$candidate_reader-mcp" >/dev/null 2>&1 || true
  docker volume rm "$candidate_hub_data" "$candidate_writer" "$candidate_reader" >/dev/null 2>&1 || true
  docker network rm "$candidate_network" >/dev/null 2>&1 || true
  rm -rf "$candidate_root"
}
trap candidate_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

mkdir "$candidate_root/source"
git archive "$candidate_sha" | tar -x -C "$candidate_root/source"
docker build --target hub --label "org.opencontainers.image.revision=$candidate_sha" \
  --tag "$candidate_tag" "$candidate_root/source"
candidate_image=$(docker image inspect "$candidate_tag" --format '{{.Id}}')
docker network create "$candidate_network"
docker volume create "$candidate_hub_data"
docker volume create "$candidate_writer"
docker volume create "$candidate_reader"
docker run --detach --name "$candidate_hub" --network "$candidate_network" \
  --network-alias candidate-hub \
  --mount "type=volume,src=$candidate_hub_data,dst=/data" "$candidate_image"
docker exec "$candidate_hub" node --input-type=module -e '
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch("http://127.0.0.1:1234/auth/claim-state", {
        signal: AbortSignal.timeout(1_000),
      });
      const state = await response.json();
      if (response.status === 200 && state.unclaimed === true && state.canClaim === true) {
        console.log("candidate hub ready: fresh and claimable");
        break;
      }
    } catch {}
    if (Date.now() >= deadline) throw new Error("candidate hub did not become fresh and claimable");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
'
docker logs "$candidate_hub"

candidate_client="$candidate_writer"
candidate_ub() {
  docker run --rm --interactive --name "$candidate_client-command" --network "$candidate_network" \
    --mount "type=volume,src=$candidate_client,dst=/data" \
    --env XDG_CONFIG_HOME=/data/config --env XDG_DATA_HOME=/data/data \
    --env XDG_CACHE_HOME=/data/cache --workdir /data \
    --entrypoint node "$candidate_image" /app/packages/cli/bin/ub.mjs "$@"
}
candidate_mcp_launcher() {
  printf '#!/usr/bin/env bash\nexec '
  printf '%q ' docker run --rm --interactive --name "$1-mcp" --network "$candidate_network" \
    --mount "type=volume,src=$1,dst=/data" \
    --env XDG_CONFIG_HOME=/data/config --env XDG_DATA_HOME=/data/data \
    --env XDG_CACHE_HOME=/data/cache --workdir /data \
    --entrypoint node "$candidate_image" /app/packages/cli/bin/ub.mjs mcp serve
  printf '\n'
}
candidate_mcp_launcher "$candidate_writer" > "$candidate_root/writer-mcp"
candidate_mcp_launcher "$candidate_reader" > "$candidate_root/reader-mcp"
chmod 700 "$candidate_root/writer-mcp" "$candidate_root/reader-mcp"
candidate_ub auth login ws://candidate-hub:1234
```

The checkout hub image contains the candidate CLI source and its dependencies,
so the image id fixes both sides even if a tag moves. The client containers
mount only their fresh volume, with separate configuration, credentials, data
and cache roots. No host home, existing credentials, database, deployment
directory or Docker socket enters them; no signing secret is passed. The
network still permits the hub's outbound GitHub requests.

Approve only this login's displayed GitHub URL and code. The approval page
names **Uberblick Login**, while the terminal names
`http://candidate-hub:1234`. The first completed sign-in claims this fresh hub's
default workspace. Record its UUID from the successful login; do not reuse the
corpus workspace UUID. After approval:

```bash
candidate_workspace='<uuid-reported-by-this-login>'
candidate_ub workspace join "ws://candidate-hub:1234/$candidate_workspace"
candidate_ub auth status ws://candidate-hub:1234
candidate_ub status --json
```

`auth status` is an offline record check. Require the live `status` reading to
name this endpoint and UUID, report a connected hub with matching protocol,
and have no pending changes. In a disposable MCP configuration, set the command
to the absolute path of `$candidate_root/writer-mcp`, with no arguments. This
launcher supplies the same Docker isolation to `ub mcp serve`. Create one
clearly synthetic document and retain its returned UUID. Wait for `sync_status`
to report its changes acknowledged. Close that MCP process before switching the
volume:

```bash
candidate_client="$candidate_reader"
candidate_ub auth login ws://candidate-hub:1234
candidate_ub workspace join "ws://candidate-hub:1234/$candidate_workspace"
candidate_ub status --json
```

Approve this second login with the same GitHub account; it obtains its own
credential for the membership already established by the claim. Change the
disposable MCP command to `$candidate_root/reader-mcp`, `get_doc` the writer's
UUID and verify its text. An edit through this reader must also arrive at the
writer after closing the reader and restarting its `$candidate_root/writer-mcp`
launcher. Read installed tool schemas first; keep this temporary MCP
configuration separate from the corpus entries. Never copy a credential from
one client volume to another.

Record the full candidate SHA, immutable image id, Docker resource names,
successful GitHub claim and second sign-in, live admission and both document
directions. Also record actual corpus-launcher resolution against the pinned
installed client on each relevant host. These are distinct proofs: a candidate
login does not establish existing-installation isolation, and a pin check does
not complete a GitHub login. An unattended start or an expired approval is not
a successful roundtrip. Report any remaining attended approval or host pin as
an operational handoff before integration; documentation alone establishes
neither. Existing corpus and development hubs remain on their old version
until a later attended upgrade is chosen.

Close every candidate MCP process, record the evidence outside the temporary
source directory, then exit this Bash session to delete its fresh containers,
volumes and network. The local build image may be retained for another
rehearsal or removed by its exact tag once unused. Use the normal `ub open`
and two-computer checks below for a deployment chosen for upgrade; this
container-only rehearsal exposes no local browser server.

### Switch an existing checkout host to a release

The old and released stacks use the same Compose project and volume names.
Take [a backup](#backing-the-hub-up) from the checkout first, then extract your
chosen release into a separate empty directory using the launch commands above,
with `~/uberblick-hub-release` in place of `~/uberblick-remote`.
Instead of copying `remote.env.example`, copy the checkout's `.env` to that
release directory and retain mode `0600`. This preserves host settings, workspaces and any `HUB_GITHUB_CLIENT_ID` override.
An old `HUB_AUTH_TOKEN` line is ignored and may be removed.

For example, with the checkout at `~/uberblick-remote` and the extracted files
at `~/uberblick-hub-release`, pull before interrupting the existing stack:

```sh
cp ~/uberblick-remote/.env ~/uberblick-hub-release/.env
chmod 600 ~/uberblick-hub-release/.env
cd ~/uberblick-hub-release
sh bin/remote-compose.sh config --quiet
sh bin/remote-compose.sh pull
cd ~/uberblick-remote
if [ -f bin/remote-compose.sh ]; then
  sh bin/remote-compose.sh down
else
  sh remote-compose.sh down # compatibility for a checkout predating bin/
fi
cd ~/uberblick-hub-release
sh bin/remote-compose.sh up --detach
```

Check HTTPS, `/ws` and the existing documents. No database is copied or moved:
the release containers reopen `uberblick-remote_hub-data`, and Caddy reuses its
existing named volumes. Keep the backup. Use only the release directory for
future operations; running the old checkout updater would replace these
containers with checkout builds. The compatibility commands remain available
[for hosts still on checkouts](#existing-checkout-deployments-compatibility).

## GitHub sign-in

Remote hubs offer GitHub sign-in through the public
[Uberblick Login](https://github.com/apps/uberblick-login) GitHub App, owned by
uberblick-ai, by default. You do not need to register an app or copy a client ID:
leave `HUB_GITHUB_CLIENT_ID` unset or empty in the host's `.env`. This applies to
the release stack and to existing checkout deployments.

Each hub runs [GitHub's device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token)
directly with GitHub, using only the public client ID and no scope. It needs no
client secret, private key or callback URL, and no Uberblick-operated service is
in the path. No GitHub configuration is served to browsers or compiled into the
web bundle. Sharing the app shares no hub authority: principals, memberships,
device credentials and revocation belong to each hub alone.

GitHub's approval page shows the app name, **Uberblick Login**, for every hub on
the default. It neither identifies nor vouches for the hub. `ub auth login`
displays the selected hub's origin next to the URL and code: approve only a login
you started for that hub. Give a first-admin setup code only to the intended
administrator, because the account approving it receives the grant.

A malformed `HUB_GITHUB_CLIENT_ID` prevents hub startup and names that setting;
it never falls back to the shared app. GitHub refusing or being unreachable
fails only the attempt in progress. Local-only work never contacts GitHub. The
hub started by `ub open` retains explicit-only sign-in: it offers it only when
`HUB_GITHUB_CLIENT_ID` is set to a valid app client ID.

### Use an operator-owned app

Choose your own GitHub App when you want to control its approval name and
settings, or keep your hubs apart from the shared app's device-flow budget and
availability. Follow
[GitHub's registration guide](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app):

1. Open your account or organization's **Settings → Developer settings → GitHub
   Apps → New GitHub App**. Choose a unique name that people will recognize
   during approval, and set the homepage to the selected hub origin, such as
   `http://localhost:8080/` or `https://<WEB_HOST>/`.
2. Under **Identifying and authorizing users**, enable **Device Flow**. Keep
   user-token expiration enabled. Leave the callback URL empty and leave
   **Request user authorization (OAuth) during installation** off.
3. Disable the webhook's **Active** checkbox. Leave repository, organization and
   account permissions at their defaults with no additional access. Subscribe
   to no events.
4. Choose **Any account** for the app's installation availability and create
   it. This makes the app public so people outside its owner can authorize it;
   see [GitHub's app visibility rules](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private).
5. Copy **Client ID** from the app's settings page, then add this one line to
   the deployment's `.env` on the host:

   ```dotenv
   HUB_GITHUB_CLIENT_ID=Iv23AbCdEF0123456789
   ```

   Replace the example with your actual client ID (the legacy `Iv1.` form or the newer
   alphanumeric `Iv23…` form). The numeric **App ID** is a different value.

Only the client ID goes to the hub container. Release updates preserve this
host setting. After saving `.env`, recreate the
hub from the deployment directory:

```sh
sh bin/remote-compose.sh up --detach hub
```

To return to Uberblick Login, remove the line or leave its value empty and
recreate the hub with the same command. An update that redeploys the hub also
applies the change; an "up to date" update does not recreate containers. Check
that the host shell does not still export the override when you recreate it.

### Shared app limits and controls

These GitHub limits cover ordinary login, first-admin setup and member lookup:

- [Device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#rate-limits-for-the-device-flow)
  permits 50 verification-code submissions per hour per application, shared by
  every hub using Uberblick Login. An operator-owned app has its own budget;
  hubs sharing that app still share it. Token polling must follow GitHub's
  returned interval; `slow_down` adds five seconds. A separate app does not
  remove this polling rule.
- [Secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits)
  include 2,000 OAuth access-token requests per hour for GitHub Apps and OAuth
  apps, plus abuse controls that can change without notice. GitHub does not
  specify the accounting key for that ceiling there, so a separate app is no
  guarantee against it. Repeated violations can cause the integration to be
  banned, affecting every hub using it.
- Reading `/user` uses the
  [user's REST API budget](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-authenticated-users):
  normally 5,000 requests per hour, combined with that person's other GitHub
  Apps, OAuth apps and personal access tokens. The documented Enterprise Cloud
  exception can raise it. An operator-owned app does not give each hub or token
  a separate user budget. The hub discards GitHub tokens after reading identity.
- Resolving a handle and granting a confirmed account each use one public,
  unauthenticated REST lookup. The hub holds no GitHub token for these calls.
  The [unauthenticated budget](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-unauthenticated-users)
  is 60 requests per hour per originating IP, shared with other unauthenticated
  calls from that IP. An operator-owned app does not change this budget.
  A rate-limited lookup returns `lookup-unavailable` and grants nothing; retry
  after the GitHub budget recovers.
- The app owner controls its
  [Device Flow, name and permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration),
  [visibility](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
  and [user-token expiration](https://docs.github.com/en/apps/maintaining-github-apps/activating-optional-features-for-github-apps).
  Disabling Device Flow or making the app private can prevent new sign-ins;
  extra permissions can change approval prompts. These changes affect every
  default hub. An operator-owned app puts those choices under your control.
- [Deleting the app](https://docs.github.com/en/apps/maintaining-github-apps/deleting-a-github-app),
  or [GitHub suspending its API access](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms),
  can stop new sign-ins at every default hub. An operator-owned app avoids
  dependence on Uberblick Login's availability, while remaining subject to
  GitHub's controls.
- [Revoking GitHub App authorization](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps)
  revokes that person's GitHub tokens for the shared app across hubs. They can
  authorize it again for a later login. This does not revoke already-issued
  Uberblick credentials; each hub owns that revocation. An operator-owned app
  separates its GitHub authorization from Uberblick Login.

GitHub documents the ten-token and ten-sign-in-per-hour rules specifically for
[OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/rate-limits-for-oauth-apps#rate-limits-for-signing-in-users);
those are not documented GitHub App limits.

### Complete sign-in

Failed attempts emit `hub.github.sign-in.failed` in the hub's stderr JSON log,
with the failing step, a fixed code and the upstream HTTP status when available.
No GitHub token, response body or upstream exception is logged. Check the app's
Device Flow setting and client ID when the code reports `device_flow_disabled`
or `incorrect_client_credentials`.

The sign-in interface is `POST /auth/github/start`, `POST /auth/github/collect`
and `POST /auth/github/cancel`. Starting returns a GitHub approval URL, short
code, bounded lifetime and a private collection secret. A device displays the
URL and code; the person approves on GitHub in any browser. Only that device's
request ID and collection secret can collect its credential, once. Keep the
collection secret private; the displayed code alone cannot collect anything.
Cancellation abandons the attempt. The hub reads the authorized public account
identity and discards GitHub's token; it accepts no supplied GitHub token or
identity. Run `ub auth login [hub]` to complete this flow from a terminal; omit
the hub to use this machine's bound hub. Approval works in a browser on any
machine and the terminal completes without further input. In a local terminal,
login opens GitHub's approval page once after displaying the hub, URL, code and
approval guidance. Over SSH or with non-terminal stdout it only displays them.
`BROWSER` names the opener command; `BROWSER=none` suppresses opening. An opener
failure does not interrupt login, and login exits without waiting for the browser.
`ub auth status [hub]`
reads the locally recorded identity and workspace limits, without checking hub
acceptance. `ub auth logout [hub]` removes only that local login; the device
keeps hub access until revoked through device management. Credentials live in
the owner-only `credentials.json` store, separate from `config.json`; these
commands never change the machine's hub or workspace binding. A new login
replaces the stored device only after completion and does not revoke the old
one. Concurrent logins and logout preserve other hubs' logins, the signing
secret and unrelated credential fields. Sign-in does not create a browser session.
The hub permits 100 active attempts, independently of finished attempts. Terminal
statuses expire no later than fifteen minutes after the attempt's expiry; at
most 100 are retained when new attempts start, evicting oldest requests first. Evicted or restarted
requests return `unknown-request`.

### Claim a fresh hub

Keep the fresh hub reachable only from the host or a private network, and
claim it before wider exposure. With the default loopback route, run this on
the host using an installed client:

```sh
ub auth login http://localhost:8080
```

The terminal says before approval when the hub is unclaimed: the GitHub account
that completes approval first becomes administrator of its default workspace.
Starting a login reserves nothing. If another reachable account completes
first, it claims the hub instead. After completion, confirm the terminal's
claim result and the default workspace UUID; this reports what the hub
committed, even if the earlier notice has become stale. Keep that UUID for
subsequent workspace use. Login stores a device credential covering the
workspace and leaves this computer's hub and workspace binding unchanged.
It does not sign a browser in.

Use the configured `LOOPBACK_PORT` if different. For a private Tailscale route,
use `ub auth login https://<WEB_HOST>` from a computer on that tailnet; existing
settings use `https://<TAILSCALE_HOST>`. The [endpoint table below](#choose-how-clients-reach-the-hub)
gives each route's login and join commands. Include `http://` for loopback:
a bare `localhost:8080` is interpreted as an HTTPS endpoint.

A deployed hub creates exactly one default workspace only when its database
contains no documents, sign-in principals, credentials, memberships or setup
receipts on its first start with this version. Its UUID, name and one-time
claim state persist in `hub.sqlite`. Restarts, container replacement and
release updates reuse them, including a later rename in Workspace Settings.
The hub created by `ub open` never initializes or claims a default workspace.
An existing deployment is never claimable, even if it has no membership; keep
using host-only first-admin setup there.

Claiming commits the first account's admin membership and device credential
together. Failure before commit claims nothing. If the completed response is
lost, the claim still stands: signing in again with that account receives a
credential for its workspace. Other completed logins grant no membership.
The first successful host-only first-admin grant, for any workspace, also
closes claiming. Claiming and host setup racing for the default workspace
can establish only one initial administrator.

A claim made by someone else cannot be recovered in place. There is no operator
override, administrator recovery or supported way to reopen claiming. The resulting membership admits that account's device credentials to its default workspace.

`GET /auth/claim-state` needs no credential and changes nothing. It reports
only `unclaimed` and `canClaim`, the latter requiring configured GitHub sign-in.
It reveals no workspace UUID, name, account, member or credential. A failed
read or an older hub is never reported as unclaimed by `ub auth login`.

Device renewal is `POST /auth/credential/renew`, beside those sign-in routes.
Its JSON body is `{protocolVersion, token}`: `token` is an HMAC-SHA256 request
proof signed with the presented credential's key, with `typ: "request"`,
`operation: "renew-credential"`, its credential UUID as `kid`, and `iat` and
`exp` in epoch seconds. The hub applies the same fifteen-minute proof lifetime
ceiling and sixty-second clock skew as room tokens. A request proof opens no
room, and a room token authorizes no renewal. Send secrets only in JSON bodies,
never URLs or an `Authorization` header; bodies are limited to 4096 bytes and
all answers are `no-store`.

Renewal needs no GitHub approval or GitHub connection. It retires the presented
credential and returns `renewed` with `credential: {record, key}` once, for the
same principal and device and exactly its current memberships, including none.
It grants no membership. Retirement closes and fences any rooms admitted under
the old credential on a remote hub.
Replaying a verified proof under that retired credential returns
`already-replaced`; unknown, revoked or unverifiable credentials return
`sign-in-required`, revealing no identity or workspace. If the replacement
answer is lost, sign in again: its key cannot be collected a second time.
Malformed requests return `invalid-request`, version skew returns
`protocol-mismatch` with the hub's version, and an unconfigured hub returns
the same `not-configured` result as sign-in. Remote clients renew stored logins
without another GitHub approval, including to discover later membership grants.

Sign-in identifies the durable GitHub account and issues one Uberblick device
credential for its workspace memberships. Only the first completed sign-in
on a fresh, unclaimed hub creates the default workspace's admin membership;
later sign-ins grant no membership.
Remote hubs require these credentials for live sync and re-check membership.
Revocation or membership removal closes existing sessions. MCP and `ub open`
keep their downloaded documents and pending edits locally; sign-in or restored
membership resumes sharing without re-joining. Loopback-only hubs retain local
signing-secret admission and need no GitHub, membership or login.

### Manage members and devices

The shared HTTP interface is `POST /auth/manage` with a JSON body
`{protocolVersion, token, operation, ...targets}`. It requires configured
GitHub sign-in. Only `resolve-account` and `grant-member` contact GitHub;
the other management operations make no GitHub call. Use
`mintRequestProof` from `@uberblick/hub/token` with the current device key,
its credential UUID as `kid`, the operation and all targets below, and
`lifetimeSeconds` (clients should use 60 seconds). The signed payload carries
`typ: "request"`, those exact fields, and `iat` and `exp` in epoch seconds.
The key stays on the device. The hub verifies against its own issued,
unrevoked, unreplaced credential and current membership. A proof cannot
authorize a different operation, workspace, device, person or role. Renewal
proofs, room tokens, GitHub tokens, another hub's credentials and the local
signing secret authorize no management. Management proofs open no room and
cannot renew. Repeating the identical request within its proof's lifetime
may repeat its effect; there is no replay cache.

| Operation | Targets in both body and proof | Successful answer |
| --- | --- | --- |
| `list-devices` | none | `{status: "ok", devices}` |
| `revoke-device` | `deviceId` | `{status: "ok"}` |
| `own-role` | `workspaceId` | `{status: "ok", role}` |
| `list-members` | `workspaceId` | `{status: "ok", members}` |
| `resolve-account` | `workspaceId`, `githubUsername` | `{status: "ok", githubAccountId, githubUsername}` |
| `grant-member` | `workspaceId`, `githubAccountId`, optional `role` (default `member`) | `{status: "ok", member}` or `{status: "already-member", member}` |
| `change-role` | `workspaceId`, `principalId`, `role` | `{status: "ok"}` |
| `remove-member` | `workspaceId`, `principalId` | `{status: "ok"}` |

Workspace IDs are bare UUIDs; roles are `admin` or `member`. Workspace
operations require both current membership and a credential naming that
workspace. Only its current admins can resolve accounts, grant, list or change members; any member
can read their own role. Member rows contain `principalId`,
`githubAccountId`, `githubUsername` (the login from the initial grant or latest
sign-in), and `role`. The final admin cannot be demoted or removed.
A non-admin member cannot remove themselves; an admin can
leave while another admin remains.

To add an account, first resolve its handle, then have the admin confirm the
returned permanent GitHub account ID and current login. Resolution grants
nothing and changes no access record. Send the confirmed `githubAccountId`
to `grant-member`, with `role: "admin"` only when explicitly intended. IDs are
canonical positive decimal strings; handles are 1–39 ASCII letters or digits,
with single hyphens only between them. The proof binds these targets too;
omitted role means `member` in both body and proof.

The hub reads `https://api.github.com/users/<encoded-handle>` for resolution
and `https://api.github.com/user/<account-id>` for the grant. It refuses
redirects, times out after 10 seconds and caps responses at 64 KiB. It accepts
only a GitHub user account with an unambiguous ID and login, and never trusts a
client-supplied login for a grant or resolves against stored logins. After the
lookup it checks the credential, proof lifetime and admin authority again,
synchronously with the write. A lost admin role, revocation or credential
replacement during the lookup prevents a grant.

An account can be granted access before its first sign-in and appears in
`list-members` immediately. `member` in the grant answer has the same fields
as a member row. Repeating or racing a grant returns `already-member` once
the membership exists, including its existing role; it never changes that
role. Use `change-role` for role changes. Lookup does not refresh existing
principals' stored logins. Access follows the account ID through a rename;
sign-in updates its stored login, while another account using the old handle
gets no access. The new account's first sign-in credential names its
workspaces; existing devices discover the grant through `/auth/credential/renew`
without another GitHub approval.

Every person can list and revoke only their own devices, including with a
credential naming no workspace. Workspace admins have no authority over
another person's devices. Device rows contain `deviceId`, `signedInAt`
(epoch milliseconds of that device's sign-in, preserved through renewal),
`workspaces` (its current credential's limits), and `current` (whether it is
making the request). Only devices with a current credential appear.
Revocation retires every credential of that device, including a replacement
from a racing renewal. Its other devices keep working. Revoking the requesting
device succeeds, then its future proofs are refused. An authorized retry
from another device repeats closure, even if the target is already revoked.

On a remote hub, revoking a device closes its live sync connections and fences
pending updates. Removing a member does the same for that person's workspace
connections on every device, preserving their access to other workspaces.
Neither operation erases downloaded documents or local edits. Management
changes no loopback admission, including the local hub served by `ub open`.

All answers are `no-store`. Send proofs only in JSON bodies of at most 4096
bytes, never URLs or an `Authorization` header. Successful operations return
HTTP 200. Invalid bodies or methods return 400 `invalid-request`; protocol
skew returns 409 `protocol-mismatch` with the hub's version. Failed proof
authentication returns 401 `sign-in-required`. Missing workspace authority
returns 403 `forbidden`, revealing no members. A foreign or unknown device
returns the same 404 `device-not-found`; an admin changing an absent member's
role receives 404 `member-not-found`. The final-admin guard returns 409
`last-admin`. Without GitHub sign-in configured every management request
returns 503 `not-configured`, as sign-in does. A storage or internal failure
returns 500 `failed`; 500 `{status: "closure-failed", applied: true}` means
the access change committed but a live closure listener failed. It is not a
refusal or rollback; retry from a credential that still has authority.

For resolution and grant, an unknown or non-user account returns 404
`account-not-found`. A GitHub error, timeout, redirect, rate limit or malformed
or ambiguous answer returns 503 `lookup-unavailable`; retry when lookup is
available. Malformed handles or IDs return 400 `invalid-request` before any
GitHub call. Every failed lookup grants nothing.

In the web interface served by `ub open`, workspace settings → **Access**
reads this management state from the bound hub. Administrators can resolve a
GitHub handle, confirm the returned login and permanent account ID, and grant
access immediately, including before the account's first sign-in. The default
role is member. Administrators can also change roles and remove members;
everyone can see their own role and list or revoke their own devices.

The browser calls only the local `ub open` process. Its management route
requires the served host, exact served origin and existing local browser
authentication, and accepts operations only for the served workspace on its
bound hub. Device credentials and management proofs stay in that process.
Every visit and change needs a reachable hub; access state is never saved in
collaborative settings, stored locally or queued for later. Local-only
workspaces have no members until `ub workspace promote` shares them, and hubs
without GitHub sign-in offer no access controls.

Removing a member ends that account's access to this workspace on every device.
Revoking a device ends that one device's access to the hub. Downloaded documents
stay where they are in either case. Revoking this computer stops its hub sync
until `ub auth login <hub>` is run again. An acknowledged change remains applied
even if the next read is refused, including after removing yourself or revoking
this computer. A `closure-failed` answer with `applied: true` also reports an
applied change, with a failed live closure.

## Establish a workspace's first administrator

For an existing deployment, or a workspace other than a fresh hub's default,
run setup in the deployment directory **on the hub host**, for example over SSH.
[GitHub sign-in](#github-sign-in) is available by default:

```sh
sh bin/hub-admin-setup.sh <workspace-uuid>
```

Name exactly one bare workspace UUID. For an existing workspace, use the UUID
`ub status` shows on a machine that holds it, including a workspace from an older deployment. Setup adopts that same workspace; it does not replace its
identity or documents. For a new workspace, choose a fresh UUID and pass it to
the same command. Setup establishes its first administrator without creating
documents or selecting the workspace in host or client configuration.

The command prints a setup ID, GitHub's approval URL and a short code. Keep
the ID for checking the result, and keep the code private: the GitHub account
that approves **that code** becomes the administrator. Open the URL in a
browser on any machine, sign in to the intended account and approve the code.
Give the code only to the intended administrator. GitHub's page names the app,
not the hub, and does not identify or vouch for the setup's hub or workspace.
The hub host needs no browser. The command waits for approval and reports the
GitHub login and durable account ID, the named workspace, and whether the hub
already held documents for that workspace. The hub logs the committed grant.
Approval expires within fifteen minutes.

Host access is the authority for this operation. The script runs a command in
the running hub container through `bin/remote-compose.sh`; the command connects to
a private Unix socket beside the hub database. No deployment HTTP or WebSocket
route can start setup, complete it or retrieve its result. A shared signing
secret, device credential or supplied GitHub token cannot authorize setup.
The hub uses GitHub's token briefly to read the approving account's public
identity, then discards it. That token is never sent to the command, printed,
logged or saved.

### What setup can change

Setup works only while the workspace has **no membership**, including a new
workspace the hub holds nothing for. It refuses a workspace with any membership
both when starting and when approval completes. Two setups racing for one
workspace can establish only one administrator. You may run the command again
for a different workspace with no membership.

Running the command does not give the host operator a role or membership. Only
the account approving its code gains that workspace's admin membership, using
the same principal that the account's ordinary GitHub sign-in reaches. Setup
issues no device credential and changes no documents, credentials or other
workspace's memberships. Its first committed grant closes fresh-hub claiming
for good. Setup remains available for an unclaimed default workspace; it races
with claiming under the same membership check. Once membership exists, setup
cannot add, replace or remove anyone there; access management belongs to that
workspace's admins. After claiming closes, ordinary sign-in grants no membership.

Setup grants the approving account access to that workspace. A machine that
signed in before setup discovers the new membership through renewal, without
new GitHub approval. Running MCP and ub open processes resume sharing with the
existing login even if they previously reported no workspace access.

### Cancellation and a missing result

Denied, abandoned, expired and failed approvals end distinctly without a grant.
With terminal input, the script allocates a container terminal so **Ctrl-C**
reaches the setup command. Over SSH, allocate a terminal with `ssh -t <hub-host>`.
Press Ctrl-C and wait for `cancelled` or an unknown-result message.
If the hub observes cancellation or interruption before committing, it fences
that setup: approving its code later grants nothing. A grant already committed
stands even if the command or its connection dies before displaying success.

With redirected input or SSH without a terminal, Compose does not forward host
signals to the command. Interrupting that host process does **not** cancel setup;
the code can still be approved until it expires. A command can also survive a
dropped SSH connection. Treat these interruptions as unknown results and check
status; they do not prove cancellation.

Losing the result does **not** establish that nothing changed. Reconnect to
the host deployment directory and use the setup ID printed by the original command:

```sh
sh bin/hub-admin-setup.sh status <setup-uuid>
```

The committed receipt is private hub data and survives a hub restart. This
lookup retrieves what that setup committed without granting or changing
anything. An unknown result never proves that nothing changed: for example,
a database restore can replace the recorded history. Check the hub's grant
logs with `sh bin/remote-compose.sh logs hub` and the applicable backups when the
receipt is unavailable. Do not interpret a connection failure or an unknown
result as permission to replace an administrator.

### Out of scope: recovery of administrator access

Setup provides no privileged recovery route. It never acts on a workspace with
membership, and access management cannot remove or demote its final admin.
Administrator authority belongs to durable GitHub account IDs. Restoring a
backup whose administrators are the same inaccessible accounts restores the
same lockout; it cannot recover those GitHub accounts.

An older backup can recover access only if its access state permits access
again: a historical administrator whose GitHub account is still accessible,
or a workspace with no membership where setup can run anew. A restore replaces
the **whole hub database**, including the documents and access state of every
workspace, not just the affected workspace. Use the
[backup and restore procedure](#backing-the-hub-up) below. Without a suitable
backup, this version offers no supported recovery. Any operator recovery route
requires a separate owner decision.

## Configure and check the stack

The extracted `docker-compose.yml` names the images and persistent volumes.
It publishes Caddy only on `127.0.0.1:${LOOPBACK_PORT:-8080}` and publishes no hub
port. The optional `remote.https.yml` replaces that publication with port 443;
`remote.tailscale.yml` adds the daemon socket only for Tailscale certificates.
Caddy's configuration lives inside the web image. `.env` at mode `0600` carries
host settings, never a remote signing secret.

Set `HUB_GITHUB_CLIENT_ID` only for an operator-owned app (see
[GitHub sign-in](#github-sign-in)); unset or empty uses Uberblick Login.
`WEB_WORKSPACES` is an optional comma-separated list of workspace UUIDs, each
optionally prefixed with a display slug (`<slug>-<uuid>`). Its first valid entry
is the workspace offered at the site's root; an empty list has nothing to open.
The host-served browser still requires the supported computer route, `ub auth login`
followed by `ub open`. Changing these settings recreates a container and needs
no bundle rebuild.

### Choose how clients reach the hub

Start a fresh hub on loopback, claim it, then choose wider access if needed.
All three routes enforce the same device credentials and workspace membership.

| Route | Network settings in `.env` | Sign in | Bind to the existing workspace |
| --- | --- | --- | --- |
| Same computer, default | None; optional `LOOPBACK_PORT=8080` | `ub auth login http://localhost:8080` | `ub workspace join ws://localhost:8080/ws/<WORKSPACE_ID>` |
| HTTPS with public DNS | `WEB_HOST=hub.example.com`; optional `HTTPS_BIND_IP=<host-ipv4>` | `ub auth login https://hub.example.com` | `ub workspace join wss://hub.example.com/ws/<WORKSPACE_ID>` |
| HTTPS with Tailscale, Linux only | `WEB_HOST=machine.tailnet.ts.net`, `TAILSCALE_IP=<tailscale-ipv4>` | `ub auth login https://machine.tailnet.ts.net` | `ub workspace join wss://machine.tailnet.ts.net/ws/<WORKSPACE_ID>` |

Use the UUID reported by the claim or first-admin setup. Use the selected port
in both loopback commands. The client's origin must be spelled consistently:
`localhost` and `127.0.0.1`, or loopback and a configured DNS name, are different
authentication origins and have separate stored logins.

**Public DNS HTTPS:** `WEB_HOST` is a public DNS name with no scheme, port or
slash. Its DNS records must reach this host, and inbound TCP 443 must reach
Caddy through any firewall or router. `HTTPS_BIND_IP` defaults to `0.0.0.0`
(all host IPv4 interfaces); set a host IPv4 address to narrow it. Caddy obtains
and renews a publicly trusted certificate using the
[TLS-ALPN challenge on port 443](https://caddyserver.com/docs/automatic-https#tls-alpn-challenge).
Port 80 is not published. Local names, IP addresses, self-signed certificates
and operator-supplied certificate files are not supported HTTPS routes.

**Tailscale HTTPS, Linux only:** connect the host to a private tailnet with
MagicDNS and HTTPS enabled. Read the full `*.ts.net` name with
`tailscale status --json` and IPv4 address with `tailscale ip -4`. Set that
address in `TAILSCALE_IP` so port 443 is published only on Tailscale, keeping
Caddy off public and LAN interfaces. The host must have the standard
`/var/run/tailscale/tailscaled.sock`. Caddy gets its certificate from that daemon,
using root inside the container for socket access; see
[Tailscale's Caddy guide](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates).
Enabling HTTPS publishes the machine name to a public certificate transparency
log; see [Tailscale's HTTPS guide](https://tailscale.com/docs/how-to/set-up-https-certificates).

**Existing Tailscale deployments:** keep their `.env` unchanged. `TAILSCALE_HOST`
is the legacy alias for `WEB_HOST`, and `TAILSCALE_IP` supplies the HTTPS bind
address. Use one host-name setting, or set both to the same name. The update commands keep
HTTPS on the existing Tailscale address and publish nothing else.

After changing network settings, validate and recreate with:

```sh
sh bin/remote-compose.sh config --quiet
sh bin/remote-compose.sh up --detach --force-recreate
```

The wrapper chooses the release's optional Compose files from `.env` automatically.
It refuses `--env-file`; put route settings in the deployment's `.env`. If you
set `COMPOSE_FILE`, you select the files yourself. Plain Compose can select the
same routes explicitly, with `.env` in the deployment directory:

```sh
# Default, same computer.
docker compose -f docker-compose.yml up --detach
# Public DNS HTTPS.
docker compose -f docker-compose.yml -f remote.https.yml up --detach
# Tailscale HTTPS, Linux only.
docker compose -f docker-compose.yml -f remote.https.yml -f remote.tailscale.yml up --detach
```

Switching routes keeps the same `uberblick-remote` project and `hub-data`,
`caddy-data` and `caddy-config` volumes, including the claim and certificate
state. Clients sign in at the new origin and join the same workspace UUID;
no device key is copied. A claim made on loopback remains claimed after wider
exposure. Never pass `--volumes` to `down` or rename the project.

`bin/remote-compose.sh` refuses unsafe settings before calling Docker. Service
entrypoints validate them again before Caddy serves, including with plain
Compose. Each refusal names the setting. The accepted values are:

| Setting | Accepted value |
| --- | --- |
| `WEB_HOST`, `TAILSCALE_HOST` | DNS name using letters, digits, `.`, `-`; a configured name must qualify for the selected certificate route |
| `LOOPBACK_PORT` | Decimal TCP port, 1–65535 |
| `HTTPS_BIND_IP` | IPv4 address; defaults to `0.0.0.0` for public DNS |
| `TAILSCALE_IP` | IPv4 address; a `*.ts.net` route requires the host's `100.64.0.0/10` Tailscale address |
| `WEB_HUB_URL` | Letters, digits, `:`, `/`, `.`, `_`, `-`; `wss://` beyond loopback |
| `WEB_WORKSPACES` | Letters, digits, `,`, `-` |

The alphabets for served values exclude quotes, backslashes and whitespace, so
substitution cannot inject another JSON key or Caddy directive. Use
`sh bin/remote-compose.sh config --quiet` before starting either layout.

### Check the deployment

Two things say the deployment is up: **the site answers**, and **`/ws`
upgrades** to a WebSocket. For the default route, run this on the host. For
HTTPS, set `site_origin=https://<WEB_HOST>` (or the existing `TAILSCALE_HOST`)
and run it from a computer that can reach that name. Allow up to 90 seconds
after startup for certificate acquisition; Tailscale obtains its certificate
on the first HTTPS request.

```sh
site_origin=http://localhost:8080
curl -sS -o /dev/null -w '%{http_code}\n' "$site_origin/"
curl --max-time 5 -sS -o /dev/null -D - "$site_origin/ws" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA=='
```

Expect `200` from the first and `101 Switching Protocols` from the second;
the upgraded socket stays open, so the second curl ends on its five-second
deadline after printing the headers. A `502` on
`/ws` is Caddy up and the hub down — expected while the hub is stopped for a
backup, and otherwise a job for `sh bin/remote-compose.sh logs hub`.

Then open the selected site origin. On a claimable fresh hub it shows
**This hub is unclaimed** and guides the first administrator through
`ub auth login`, `ub workspace join` with the default workspace UUID reported by
that login, and `ub open` on their computer. An open page rechecks claim state
after each 15-second pause until claiming closes. A closed claim says only that
the hub can no longer be claimed; an existing installation sealed without a
claim gives the same answer. Members sign in, join their workspace unless
already bound to it, and use `ub open`. This browser is never signed in by those
steps. A failed, timed-out or incompatible claim-state read says setup state
could not be confirmed; an unclaimed hub unable to accept a claim says GitHub
sign-in is not configured. Every app address shows the guide, with no documents,
editor actions or collaboration socket. In browser developer tools,
`/uberblick-config.json` must return only `hubUrl` and `workspaces`: by default,
`{"hubUrl":"ws://localhost:8080/ws","workspaces":"<the list from .env>"}`.
For HTTPS the endpoint is `wss://<WEB_HOST>/ws`, or the legacy Tailscale name.
It contains no signing secret or device credential. A release bundle has no
deployment endpoint fallback; the browser console names the configuration
sources in force.

### Pointing the client at another hub

The release bundle takes `hubUrl` and `workspaces` from `/uberblick-config.json`
on its serving origin. No deployment value or credential is compiled into it.
Caddy renders that public document from its checked runtime environment:
`WEB_HUB_URL` (default `ws://localhost:<LOOPBACK_PORT>/ws` on loopback or
`wss://<WEB_HOST>/ws` for HTTPS) and `WEB_WORKSPACES`
(default empty). Changing either needs a Caddy container recreate, never a bundle
rebuild:

```sh
sh bin/remote-compose.sh up --detach caddy
```

The document is served with `Cache-Control: no-store`, so the next page load
picks up the change. `hubUrl` must be a plain `ws://` or `wss://` address without
userinfo, query or fragment. Invalid workspace entries are dropped. Direct
remote browser sign-in remains unavailable, regardless of workspace list.
The host's guide reads only `GET /auth/claim-state` at its own origin, with no
credential, and fills its computer commands with that origin, even when
`WEB_HUB_URL` points elsewhere. The public answer contains only `unclaimed`
and `canClaim`, never a workspace or identity. The guide grants no document
access. Use `ub open` after signing in and binding to edit from a computer's
local replica; its page and loopback development do not show the setup guide.

## Two-computer verification protocol

Choose an HTTPS route reachable from computers A and B; a private tailnet is
recommended. Before starting, run `ub auth login https://<WEB_HOST>` and
`ub workspace join wss://<WEB_HOST>/ws/<WORKSPACE_ID>` on each (use the legacy
`TAILSCALE_HOST` for an existing deployment). Then run `ub open`, choose the same document, and give each browser a
distinct awareness name/color if prompted.

1. **Live edit and cursor:** type a distinctive sentence on A. Confirm it
   appears on B without reloading and that B renders A's remote cursor or
   selection.
2. **Local MCP to locally served browser:** bind and sign in on the computer
   launching MCP, then use `edit_block` on the open document and confirm the edit
   appears live in B's `ub open` page. `sync_status` must report the remote URL
   and a connected hub. No signing secret or GitHub token is copied or sent.

3. **Offline convergence:** disconnect A from the network, then edit the same
   document on A and B (use different blocks for an unambiguous merge). Restore
   A's network. Confirm both browsers converge to the same text and neither
   edit disappears.
4. **Hub restart durability:** make one more edit and wait until it appears on
   both computers. On the host run `sh bin/remote-compose.sh restart hub`, then
   reload B. Confirm the document and the last edit remain.
5. **Named-volume durability:** record a distinctive document title, then run
   `sh bin/remote-compose.sh down` followed by
   `sh bin/remote-compose.sh up --detach`. Reload B and confirm the title remains
   and the directory hydrates. Do not pass `--volumes` to `down`; that flag
   intentionally deletes the named SQLite volume.

Record the host name, date, browser/OS pairs, and pass/fail result for every
step in issue #98. The physical two-computer checks are deployment evidence;
they are not replaced by the repository's local test suite.

## Operations

```sh
sh bin/remote-compose.sh logs --follow hub caddy
sh bin/remote-compose.sh restart hub
sh bin/remote-compose.sh down
sh bin/remote-compose.sh up --detach
```

Deploying a newer release is [its own runbook](#updating-the-host--deliberately).
A Linux checkout host stood up before 2026-08-25 carries the retired
`uberblick-update.timer`; retire it once on that Linux host. These `systemctl`
commands do not apply to Docker Desktop on macOS:

```sh
systemctl --user disable --now uberblick-update.timer
rm -f ~/.config/systemd/user/uberblick-update.timer \
      ~/.config/systemd/user/uberblick-update.service
systemctl --user daemon-reload
systemctl --user list-timers --all | grep uberblick   # expect no output
```

The hub handles Compose's `SIGTERM` by flushing pending document updates before
it exits. SQLite is `/data/hub.sqlite` in the `hub-data` named volume, so normal
container replacement and `sh bin/remote-compose.sh down` preserve it.

### Backing the hub up

```sh
sh bin/hub-backup.sh ~/uberblick-hub-$(date +%Y-%m-%d).sqlite
```

Run it from the host's deployment directory, which contains `bin/`. You can
also invoke the script by its absolute path from any directory; a relative
backup filename is resolved in your current directory. It **stops the
hub, copies, and starts it again** — and the stop is the point, not an inconvenience.
Hocuspocus debounces the store (2s, at most 10s; the hub leaves both at their
defaults), so a document edited a moment ago may exist only in the hub's memory.
The only flush an operator can reach is a shutdown: `SIGTERM` makes the hub
write every pending update and close the database, and `stop_grace_period: 30s`
already leaves room for that 10s ceiling. Copying a *live* file instead would
capture whatever SQLite happened to have on disk — a file that opens perfectly
and is missing the last few minutes of work.

**The hub's own verdict is what decides.** `docker compose stop` exits 0 whatever
the container did, so the script reads the exit code separately, from
`ps -a --format json` → `ExitCode`. Non-zero — including `137`, the grace period
expiring — means the flush did not finish, and **no file is written at all**. A
backup nobody can trust is worse than no backup, because it is the one that gets
restored. The hub is started again from the exit and signal traps on every path
— an `EXIT` trap alone does not run when a signal kills the script: with
`restart: unless-stopped`, a manual stop survives a Docker restart, so a run that
died between the stop and the start would leave the hub down for good.

The file lands at mode `0600`, and it lands whole: the copy goes to a temporary
sibling and is renamed onto the name you gave, so an interrupted run leaves the
previous backup exactly as it was rather than a truncated file wearing its name.
It contains the documents, default workspace and claim state, and private access
records of every workspace in one readable file; keep it private like a device
credential. Naming an existing
directory, or a directory that is not writable, is refused before the hub is
stopped.

**Local replicas keep working while the hub is stopped.** Caddy stays up and
serves the app; `/ws` answers 502 for those seconds. MCP and `ub open` keep
reading and editing their local copies and converge when the connection returns.
A browser opened at the remote host has no document access. The window is a few
seconds, but take backups when you would take a deploy.

### Restoring one

```sh
sh bin/hub-restore.sh ~/uberblick-hub-2026-08-28.sqlite
```

**Verified before anything is touched.** A restore runs on somebody's worst day,
against a file nobody has opened since it was written, over the only copy that is
left. So the backup is read first — `PRAGMA integrity_check`, *and* documents
or private access state. Identities, credentials, memberships, committed
setup receipts and persistent claim state are worth restoring even before the
first document exists.
A database with neither documents nor private access records is refused:
it passes the pragma but would restore nothing. That check runs inside the hub's
own image through `node:sqlite`, the module the hub itself persists with (the
image is `node:26-bookworm-slim` and carries no `sqlite3` CLI), and writes the
candidate to the container's `/tmp`, never to `/data`. A missing, corrupt or
empty backup exits non-zero **with the hub still running and the volume
untouched**.

Only then does it stop the hub — and even then it **never writes over the live
database**. The file is copied in as `/data/hub.sqlite.restoring`, a name the
hub does not open; only once that copy is whole and owned by the container's
`node` user does a single `mv -f` put it in place, which within one filesystem
is atomic. So a copy that dies half way — a full disk, a killed daemon, an
interrupted script — leaves the database that was already there intact, and the
script says the live database was **not** replaced and exits non-zero.

**A rollback journal stops the restore rather than being worked around.** After
the stop, the script looks in the volume for a `hub.sqlite-*` sidecar. If one is
there the database is mid-transaction and the journal is the half that says what
to undo — one unit, and not one a restore should take apart: replace the
database and the journal describes a file that is gone; delete the journal and
the old database loses the rollback it needs; and every way of moving it out of
the way has a window where an interruption leaves exactly one of those. So it
copies nothing, touches nothing, and says so.

Clearing it is one line, and SQLite does the work: a journal is recovered on the
next clean open.

```sh
sh bin/remote-compose.sh up --detach hub
sh bin/remote-compose.sh stop hub
sh bin/hub-restore.sh ~/uberblick-hub-2026-08-28.sqlite
```

A hub that exited non-zero but left no journal is not blocked — that is often
exactly why somebody is restoring. The exit code is reported either way.

Then the hub starts. It restores into an empty volume
just as well as over an existing one, which is the case the drill on #404
exercises: `down --volumes`, `up`, restore, and a fresh client with empty local
state enumerating and reading the pre-backup corpus.

Both scripts drive Compose through the shared `sh bin/remote-compose.sh`, in a
release directory or a compatibility checkout. Restore uses the same shell,
Node runtime and `node` user included in the hub image; it needs no host
database utility.

### What a backup is actually for

Every MCP server holds the **entire** workspace and hydrates from its own
append-only update log; `_directory` and `_sidebar` are synced documents like
any other. So the *content* is
restorable without a backup at all: stand up an empty hub, let one machine
reconnect, and the corpus comes back off that replica.

What no replica gives you is **point-in-time recovery** — yesterday's text of a
document somebody has since mangled, in a system where every mangling replicates
within a second. Backups also preserve the hub's private principal, credential
and membership registries, default workspace identity and claim state in
`hub.sqlite`. Client replicas cannot restore those private records; restoring
an older backup also restores its older access state. The default workspace's
name lives in its synchronized settings room and is included in the same backup.

**Retention and encryption at rest are the owner's**, deliberately: how many of
these files to keep, where they live, whether they are encrypted or copied off
the host. Nothing here schedules a backup, rotates one, or sends one anywhere.

## Create and promote a project workspace

Run these commands in the project directory on the computer holding its documents:

```sh
ub workspace create "Project notes"
ub workspace promote http://localhost:8080
```

`create` makes and selects a local-only workspace with a fresh UUID, name and
starter documents/sidebar. `promote` reuses this hub's stored login, or runs
GitHub approval if there is no working login. Your account must currently be a
member or administrator of at least one workspace on the hub. The login that
claims a fresh hub's default workspace qualifies. Signing in otherwise grants
nothing.

Promotion grants this account the new workspace's sole initial admin membership,
then renews its device credential, uploads documents (including archived
content), name and sidebar, and verifies the copy with a fresh authenticated
client. It preserves the UUID and CRDT history. Only after verification does it
bind the project to the hub; no separate join or host command is needed.
Promotion prints the complete connection URL for joining on another machine.

A destination with documents or memberships is refused. The exception is the
same recorded promotion attempt: after a failure or interruption, rerun the
command on this machine. Keep its private saved attempt with the local data;
the hub stores its receipt atomically with the grant. The project binding stays
unchanged on failure and local work remains available. Close other clients while
promoting. A workspace already bound to a hub cannot be promoted. The reservation
itself does not change the hub's default workspace, first-claim state or other
memberships. On a fresh hub, the sign-in requested by promotion can claim the
default workspace through the normal first-login flow.

Host-only first-administrator setup remains a separate operation for workspaces
without membership, existing or new. Its Unix-socket authority and restrictions are
unchanged. Promotion's authenticated HTTP request can reserve only a new, empty
UUID for an existing workspace member or administrator; it cannot adopt an
unrelated populated one.

Existing MCP registrations keep their workspace/hub pins after creation or
promotion. Add a named entry for the new selection when needed. Browser and MCP
use of a local-only workspace requires neither login nor promotion.

## Binding a computer to this hub's workspace

A fresh release hub creates its default workspace and changes no client binding.
Claiming it through `ub auth login` also leaves the binding unchanged. Each computer
that will use an existing workspace joins it explicitly. These commands run on
the computer using the workspace, which can also be the Docker host for the
default loopback route. The deployment and operator scripts run on the host.

There is one verb for joining a workspace that exists, and it is the same on
every machine:

```sh
ub auth login http://localhost:8080
ub workspace join ws://localhost:8080/ws/<WORKSPACE_ID>
```

These are the default same-computer commands. For HTTPS, use
`ub auth login https://<WEB_HOST>` and
`ub workspace join wss://<WEB_HOST>/ws/<WORKSPACE_ID>`; the
[route table](#choose-how-clients-reach-the-hub) includes the legacy Tailscale
route and configurable loopback port. The URL is the endpoint with the
workspace id as its last path segment. Sign in first; no `ub init`,
`--workspace` or clone is needed. The id is what a second machine has to be told, because a workspace id is
a uuid: a machine that invented its own would join the hub and find nothing of
yours there, the rooms being keyed by a different id. Carrying it in the URL is
what makes that one string, and one paste, rather than two.

`join` binds this machine to the workspace the URL names **whatever is here
already**, pulls the whole remote directory and every live and archived document
room into the local update log for it, then has a fresh client verify the full
directory, every archived room and one sampled live room. Only then does it
persist the endpoint and the binding. It seeds nothing into a joined workspace:
the documents come off the wire. An unreachable or auth-rejecting remote writes
nothing at all.

A machine that already had a workspace of its own keeps it. It is not merged and
not moved: `ub workspace list` shows both, and
`ub workspace use <id> --hub <url|local>` selects the previous complete binding.
Other projects retain their bindings. Access still requires current membership.

A URL with no workspace id, or with something that is not one, is refused before
anything is written, and the refusal names the form.

`ub init <hub-origin> --workspace <uuid>` also authenticates with this hub's
stored login before writing, and requires workspace access. Without an existing
workspace or `--workspace`, its new random UUID has no membership and is refused. It never overwrites an existing endpoint;
use `ub workspace join` to move a binding. No signing secret grants remote access.
For an existing workspace, use the join route above and keep its UUID.

To edit this workspace in a browser on the computer, run `ub open`. It serves
the machine's local replica, uses the stored login for upstream sync, and gives
the browser a separate loopback key. It serves neither a device credential nor
an upstream secret. Before login, a client reaching this deployed hub asks you
to sign in to it. If the Docker stack is stopped, clients report the hub
unreachable; `ub open` keeps serving local documents and never starts a hub at
that deployment endpoint. The hub `ub open` starts for ordinary local work
and `mise run dev`'s loopback development hub keep working without a login.

Persisting a selection writes the complete workspace and hub binding to the
nearest `.uberblick.json`, or creates that file in the current folder. All CLI
commands and MCP use it. A complete `UB_WORKSPACE_ID` and `UB_HUB_URL` environment
pair overrides it atomically; incomplete overrides fail. New MCP installations
pin both values, including a selected `--workspace <id> --hub <url>` override.
Credentials remain private and separate. The deployed web client reads its
endpoint at runtime from `/uberblick-config.json` rather than these client files.

Remote commands accept no signing secret and send no GitHub token. A missing
login names `ub auth login`; a refused renewal requires signing in again; missing
workspace access names the workspace administrator. Refusal keeps the command's
existing no-write promise. The signing secret in `credentials.json` stays for
loopback-only hubs and is never sent to this deployed hub, including its
host-loopback route.

Archived documents move with their content and stay archived until restored.
Merging two independently populated workspaces is not supported: the URL says
which workspace `join` is about — that one's two replicas reconcile as CRDTs,
and the others on the machine are left alone.


## Existing checkout deployments (compatibility)

The release procedure above is the supported launch and update path. Existing
source-checkout hosts retain their Docker Compose stack until they migrate to a
release. This path remains Linux-only and requires Tailscale, Docker Compose
2.6+, git and an existing configured checkout. Its root `docker-compose.yml`,
source-build Dockerfile stages and `bin/remote-compose.sh` remain available.

### Updating a checkout host

The host never updates itself. Run this on the host, from its existing checkout,
while present to verify the result:

```sh
sh remote-update.sh
```

The script fetches `origin/main`, resets the host checkout to it, rebuilds and
recreates the containers through `bin/remote-compose.sh`, then records the
successfully deployed commit. It reports either “up to date” or the commit it
moved to. It preserves the untracked `.env`, including `HUB_GITHUB_CLIENT_ID`.
Tracked host-local edits are deliberately discarded and reported; the host is a
deployment checkout, not an editing workspace. No timer or webhook runs this.

A checkout-wide `flock` prevents concurrent deployments from interleaving.
Contention reports “already running; nothing to do”; a host unable to acquire a
working lock refuses. Separate checkouts can still deploy independently.
The comparison is against `refs/uberblick/deployed`, which advances only after
a successful build. A failed build is retried on the next update.

If a change alters wire semantics, update the hub and every client in the same
sitting and reload open browser tabs. If both halves cannot be completed now,
postpone the update. Run client login and `ub workspace join` separately when
connecting a computer; deployment never selects that computer's workspace.
