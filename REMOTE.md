# Remote deployment over Tailscale

Run a published hub release on a Linux x86_64 host with Docker and Tailscale.
The host needs no repository checkout, build tools, `ub`, GitHub account or
registry login. One version supplies the hub image, the prebuilt web image and
all host files. Caddy serves the app and `/uberblick-config.json`, proxies `/ws`
and `/auth/*` to the hub, and asks the host's Tailscale daemon for the HTTPS
certificate. The hub is not published directly.

> Remote sync admits only device credentials with current workspace membership. Run `ub auth login` on each computer and unattended agent host, then use the MCP server or `ub open`. The host's web page receives no credential and shows no documents: direct browser sign-in is not available yet. A signing secret left in an old `.env` grants no access. Revocation stops live sync but cannot erase data already downloaded.

The access-control boundary and broader-access requirements are described in
the corpus Configuration and auth (62c70b7c-6e4c-40a4-a6bb-a7edbee08360).

## Host prerequisites

Check these before deploying:

- **A Linux x86_64 host with Docker Engine and Docker Compose 2.6.0 or newer.**
  Only `linux/amd64` images are published. Compose 5 satisfies the floor too.
  `docker compose version --short` checks the plugin; `docker info` checks that
  your host user can reach the daemon. If the Docker socket refuses access,
  add that user to the host's `docker` group and open a new session.
- **Tailscale, connected to a private tailnet**, with MagicDNS and HTTPS enabled.
  Read the full `*.ts.net` hostname from `tailscale status --json` and the IPv4
  address from `tailscale ip -4`. Enabling HTTPS publishes the certificate's
  machine name to a public certificate transparency log; see
  [Tailscale's HTTPS guide](https://tailscale.com/docs/how-to/set-up-https-certificates).
- **TCP port 443 free on that Tailscale IPv4 address.** Compose publishes only
  `<TAILSCALE_IP>:443`, keeping Caddy off public and LAN interfaces, and publishes
  no hub port. Docker binds it before Caddy starts; an address-in-use error is
  reported by the daemon, so empty Caddy logs do not diagnose it.
- **An operator session on the host**, locally or over SSH. Tailscale SSH is
  sufficient. The operator deliberately launches and updates the stack; no
  timer, webhook or polling loop does it. Use `ssh -t` for setup cancellation
  through Ctrl-C.

The stack uses the standard `/var/run/tailscale/tailscaled.sock`, bind-mounted
into Caddy, which runs as root inside its container to reach it. This is one of
the certificate access modes in
[Tailscale's Caddy guide](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates).
Every other process runs in the published containers, including backup,
restore and first-admin setup. The host needs no Node, pnpm or `sqlite3`.

## Stand it up from a release

Choose an existing published hub version explicitly. The version below is an
example, not a moving channel. Run these commands **on the hub host**, in an
empty deployment directory:

```sh
mkdir -p ~/uberblick-remote
cd ~/uberblick-remote
HUB_VERSION=0.1.0
docker pull "ghcr.io/uberblick-ai/hub:$HUB_VERSION"
release_container=$(docker create "ghcr.io/uberblick-ai/hub:$HUB_VERSION")
docker cp "$release_container:/release/." .
docker rm "$release_container"
cp remote.env.example .env
chmod 600 .env
```

`docker create` does not start the container. The copied files include the
version's `docker-compose.yml`, `remote.env.example` template,
`remote-settings.sh`, operator commands in `bin/`, this manual, RELEASING.md and
`release.json`. The Compose file names both exact versioned images; it has
no host build. The same prebuilt web image serves every host, with its endpoint
and workspace list supplied only by `/uberblick-config.json`.

Fill in `.env` using [the settings below](#configure-and-check-the-stack), then:

```sh
sh bin/remote-compose.sh config --quiet
sh bin/remote-compose.sh pull
sh bin/remote-compose.sh up --detach
sh bin/remote-compose.sh ps
sh bin/remote-compose.sh logs --tail=100 hub caddy
```

[Check HTTPS and the WebSocket upgrade](#check-the-deployment) from another
machine on the tailnet, then [claim the fresh hub](#claim-a-fresh-hub) with
`ub auth login <TAILSCALE_HOST>`. Confirm that the completed login reports the
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
docker run --rm --entrypoint cat "ghcr.io/uberblick-ai/hub:$HUB_VERSION" \
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
docker pull "ghcr.io/uberblick-ai/hub:$HUB_VERSION"
release_container=$(docker create "ghcr.io/uberblick-ai/hub:$HUB_VERSION")
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

Check HTTPS and `/ws` again. The project remains `uberblick-remote`, and its
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
an existing hub upgrade. To keep an existing installation on its current
protocol while trying a candidate, first
[pin its corpus client](README.md#keep-the-corpus-client-independent-of-the-checkout)
and use the [isolated candidate procedure below](#try-a-candidate-on-a-fresh-isolated-hub).

Prepare the old deployment before switching either side:

1. Configure GitHub sign-in on the existing hub (the public Uberblick Login app
   is the standalone default).
2. Run host-only first-admin setup for each existing workspace, retaining its UUID.
3. Run `ub auth login <TAILSCALE_HOST>` on **every** computer and unattended agent
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
finding an older executable on PATH does not prove either. Follow
[the corpus-client pin procedure](README.md#keep-the-corpus-client-independent-of-the-checkout)
before new launcher definitions become active, including its actual worker MCP
check from a private checkout. For an existing `ub open`, use that same explicit
installed client. Leave the existing hub, bindings, credentials, local stores
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
published. That hostname selects remote device authentication; a client
dialling `127.0.0.1` or `localhost` would instead select loopback admission.

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
candidate_ub remote join "ws://candidate-hub:1234/$candidate_workspace"
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
candidate_ub remote join "ws://candidate-hub:1234/$candidate_workspace"
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
   during approval, and set the homepage to `https://<TAILSCALE_HOST>/`.
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

Only the client ID goes to the hub container. Both `ub remote init` re-runs and
`ub remote update` preserve this host setting. After saving `.env`, recreate the
hub from the deployment directory:

```sh
sh bin/remote-compose.sh up --detach hub
```

To return to Uberblick Login, remove the line or leave its value empty and
recreate the hub with the same command. An update that redeploys the hub also
applies the change; an "up to date" update does not recreate containers. Check
that the host shell does not still export the override when you recreate it.

### Shared app limits and controls

These GitHub limits include both ordinary login and first-admin setup:

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
machine and the terminal completes without further input. `ub auth status [hub]`
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

Keep the hub on an isolated network such as Tailscale, and claim it before
wider exposure. From any computer that can reach the running stack, run:

```sh
ub auth login <TAILSCALE_HOST>
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

A deployed hub creates exactly one default workspace only when its database
contains no documents, sign-in principals, credentials, memberships or setup
receipts on its first start with this version. Its UUID, name and one-time
claim state persist in `hub.sqlite`. Restarts, container replacement and
`ub remote update` reuse them, including a later rename in Workspace Settings.
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
GitHub sign-in, but a management request makes no GitHub call. Use
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
| `change-role` | `workspaceId`, `principalId`, `role` | `{status: "ok"}` |
| `remove-member` | `workspaceId`, `principalId` | `{status: "ok"}` |

Workspace IDs are bare UUIDs; roles are `admin` or `member`. Workspace
operations require both current membership and a credential naming that
workspace. Only its current admins can list or change members; any member
can read their own role. Member rows contain `principalId`,
`githubAccountId`, `githubUsername` (the latest GitHub login seen at sign-in),
and `role`. The final admin cannot be demoted or removed. No operation here
adds membership. A non-admin member cannot remove themselves; an admin can
leave while another admin remains.

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

## Establish a workspace's first administrator

For an existing deployment, or a workspace other than a fresh hub's default,
run setup in the deployment directory **on the hub host**, for example over SSH.
[GitHub sign-in](#github-sign-in) is available by default:

```sh
sh bin/hub-admin-setup.sh <workspace-uuid>
```

Name exactly one bare workspace UUID. For an existing workspace, use the UUID
`ub status` shows on a machine that holds it, including the workspace deployed
by `ub remote init`. Setup adopts that same workspace; it does not replace its
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

The extracted `docker-compose.yml` is the release's recipe: it identifies the
images, persistent volumes and the sole published port. Caddy's configuration
is inside the web image; no host Caddyfile is needed. The host supplies `.env`
at mode `0600`. It carries host settings, never a remote signing secret.

Edit `.env` using `remote.env.example`. Set `TAILSCALE_HOST`, `TAILSCALE_IP`
and choose the `WEB_WORKSPACES` list. `WEB_HUB_URL` is
optional (see [Pointing the client at another hub](#pointing-the-client-at-another-hub)).
Set `HUB_GITHUB_CLIENT_ID` only for an operator-owned app (see
[GitHub sign-in](#github-sign-in)); unset or empty uses Uberblick Login.

- `TAILSCALE_HOST` is the host's full `*.ts.net` MagicDNS name, with no scheme
  or trailing slash.
- `WEB_WORKSPACES` is the comma-separated list of workspaces the web client
  offers, and its first entry is what `https://<TAILSCALE_HOST>/` opens. Use the
  workspace id `ub status` prints on the machine whose documents this hub is
  for, optionally decorated with a display slug (`<slug>-<uuid>`). Left at the
  placeholder, the root address has nothing to open and says so — document links
  still work, and the switcher shows only the workspace the address names. The
  value may contain only letters, digits, `,` and `-`; `bin/remote-compose.sh`
  refuses anything else, because the list is substituted into the JSON
  configuration document and a quote there could inject a second `hubUrl` that
  retargets every browser. That refusal is the guarantee: no quote and no
  backslash reaches the document, so no escape can be written into it. The
  client also refuses a document that plainly names a key twice, but that is
  best-effort defence in depth — it reads raw JSON spelling, so an escaped key
  would slip past it, and anyone able to write into the served document could
  set `hubUrl` outright anyway. A document an attacker controls is outside this
  deployment's threat model.
- `TAILSCALE_IP` is the IPv4 address printed by `tailscale ip -4`. Compose binds
  port 443 only to this address, not to the host's public or LAN interfaces.


`bin/remote-compose.sh` reads `.env` and refuses unsafe values before calling
Docker. The web container checks them again before Caddy starts, including when
started by plain `docker compose up`: an unchecked value never enters the
served JSON. A refusal names the setting. The allowed alphabets are:

| Setting | Allowed characters |
| --- | --- |
| `TAILSCALE_HOST` | Letters, digits, `.`, `-` |
| `WEB_HUB_URL` | Letters, digits, `:`, `/`, `.`, `_`, `-` |
| `WEB_WORKSPACES` | Letters, digits, `,`, `-` |

Use the wrapper for operator commands in either deployment layout. Validate with `sh bin/remote-compose.sh config --quiet`.

### Check the deployment

Two things say the deployment is up: **the site answers** on
`https://<TAILSCALE_HOST>/`, and **`/ws` upgrades** to a WebSocket. The first
request is what makes Tailscale issue the certificate, so a check that fails immediately after `up` is a false negative —
give it up to 90 seconds. From another machine on the tailnet:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<TAILSCALE_HOST>/
curl -sS -o /dev/null -D - https://<TAILSCALE_HOST>/ws \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA=='
```

`200` from the first, `101 Switching Protocols` from the second. A `502` on
`/ws` is Caddy up and the hub down — expected while the hub is stopped for a
backup, and otherwise a job for `sh bin/remote-compose.sh logs hub`.

Then open `https://<TAILSCALE_HOST>` from another device. It shows **Sign-in
required**, explains that this browser cannot sign in yet, and names
`ub auth login` with `ub open` on a computer. It shows no documents and opens
no collaboration socket. In browser developer tools,
`https://<TAILSCALE_HOST>/uberblick-config.json` must return only:
`{"hubUrl":"wss://<TAILSCALE_HOST>/ws","workspaces":"<the list from .env>"}`.
It contains no signing secret or device credential. A release bundle has no
deployment endpoint fallback; the browser console names the configuration
sources in force.

### Pointing the client at another hub

The release bundle takes `hubUrl` and `workspaces` from `/uberblick-config.json`
on its serving origin. No deployment value or credential is compiled into it.
Caddy renders that public document from its checked runtime environment:
`WEB_HUB_URL` (default `wss://<TAILSCALE_HOST>/ws`) and `WEB_WORKSPACES`
(default empty). Changing either needs a Caddy container recreate, never a bundle
rebuild:

```sh
sh bin/remote-compose.sh up --detach caddy
```

The document is served with `Cache-Control: no-store`, so the next page load
picks up the change. `hubUrl` must be a plain `ws://` or `wss://` address without
userinfo, query or fragment. Invalid workspace entries are dropped. Direct
remote browser sign-in remains unavailable, regardless of workspace list;
opening the host shows the supported computer route and no documents. Use
`ub open` after binding and signing in to edit from a computer's local replica.

## Two-computer verification protocol

Use computers A and B on the same tailnet. Before starting, run `ub auth login <TAILSCALE_HOST>` and join the workspace
on each, then run `ub open`, choose the same document, and give each browser a
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
A host stood up before 2026-08-25 carries the retired `uberblick-update.timer`;
retire it once, on that host:

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

## Binding a computer to this hub's workspace

A fresh release hub creates its default workspace and changes no client binding.
Claiming it through `ub auth login` also leaves the binding unchanged. Each computer
that will use an existing workspace joins it explicitly. Which process runs
where matters: everything in this section runs on **your** computers, not on the
remote host, which runs the deployment and operator scripts.

There is one verb for joining a workspace that exists, and it is the same on
every machine:

```sh
ub auth login <TAILSCALE_HOST>
ub remote join wss://<TAILSCALE_HOST>/ws/<WORKSPACE_ID>
```

The URL is the endpoint with the workspace id as its last path segment. Sign in first; no `ub init`, `--workspace` or clone is needed. The id is what a second machine has to be told, because a workspace id is
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
not moved: `ub workspace list` shows both, and `ub workspace use <id>`
switches back. The endpoint, though, is machine-wide — after a join, another local workspace can sync with this hub only when the
stored login and current membership allow that UUID.

A URL with no workspace id, or with something that is not one, is refused before
anything is written, and the refusal names the form.

`ub init <TAILSCALE_HOST> --workspace <uuid>` also authenticates with this hub's
stored login before writing, and requires workspace access. Without an existing
workspace or `--workspace`, its new random UUID has no membership and is refused. It never overwrites an existing endpoint;
use `ub remote join` to move a binding. No signing secret grants remote access.
For an existing workspace, use the join route above and keep its UUID.

To edit this workspace in a browser on the computer, run `ub open`. It serves
the machine's local replica, uses the stored login for upstream sync, and gives
the browser a separate loopback key. It serves neither a device credential nor
an upstream secret. `mise run dev` is the loopback development path and does not
support remote sync.

Persisting the endpoint — and, after a join, the workspace binding — writes
`$XDG_CONFIG_HOME/uberblick/config.json`, which is the only place `ub`,
`ub mcp serve`, the MCP server it spawns and every checkout task under `ub env`
resolve them from — an endpoint in the environment is not read at all. The
*workspace* can still be outranked by `WORKSPACE_ID` there, and a project MCP
entry pinned with `ub mcp install --project --workspace <id>` is exactly how one
gets into an agent session's environment; `join` names the winner instead of
claiming a switch that did not take effect. The deployed web client here reads
its endpoint at runtime from the served `/uberblick-config.json`, not from any
of them.

Remote commands accept no signing secret and send no GitHub token. A missing
login names `ub auth login`; a refused renewal requires signing in again; missing
workspace access names the workspace administrator. Refusal keeps the command's
existing no-write promise. The signing secret in `credentials.json` stays for
loopback hubs and is never sent to this remote.

Archived documents move with their content and stay archived until restored.
Merging two independently populated workspaces is not supported: the URL says
which workspace `join` is about — that one's two replicas reconcile as CRDTs,
and the others on the machine are left alone.

## Existing checkout deployments (compatibility)

The release procedure above is the supported launch and update path. Existing
checkout hosts can still use these shipped commands until they switch to a
release. They need `git` on the host and a repository checkout; initial setup
also needs a GitHub login with repository admin rights on your own machine
(`gh auth login --scopes repo`) to register the host’s read-only deploy key.
These requirements belong only to the checkout path.

### Initialize or re-run a checkout host

One command, from your own machine with SSH access to the host and a GitHub
login for repository administration:

```sh
ub remote init uberblick@box.tailnet.ts.net
```

It does, over that one SSH target, the compatibility checkout deployment:

1. Checks the host — Docker Compose 2.6+, `git`, and `tailscale status --json`
   for the MagicDNS name and `tailscale ip -4` for the address. Detection
   failing is a prompt or `--host <fqdn> --ip <v4>`, never a guess, and it says
   which of the three it was: tailscale absent, tailscaled not up, or the local
   API refused because the SSH user is not the tailscale operator (fixed on the
   host with `tailscale set --operator=<user>`).
2. Generates an ed25519 deploy key **on the host** — it never leaves it — and
   registers its public half read-only with `gh repo deploy-key add`, titled
   `uberblick-<hostname>-<short-fingerprint>`. A key already registered is
   detected by the key itself, never by its title, so a second run adds nothing.
3. Clones `main` into `~/uberblick-remote` (`--dir` to change) with
   `core.sshCommand` set on the clone, so the updater needs no environment of
   its own. An existing checkout is fast-forwarded instead.
4. Writes the host's `.env` — `TAILSCALE_HOST`, `TAILSCALE_IP` and
   `WEB_WORKSPACES` with this machine's resolved workspace UUID — over stdin.
   It preserves an operator's `HUB_GITHUB_CLIENT_ID` override and writes no
   signing secret.
5. Runs `sh bin/remote-compose.sh up --build --detach`, then verifies from your
   machine: it polls `https://<host>/` for up to 90 seconds — the first request
   is what makes Tailscale issue the certificate, so an immediate check is a
   false negative — and confirms `/ws` upgrades to a WebSocket. A failure exits
   non-zero with the last hub and Caddy log lines, and persists nothing.
6. Records the endpoint and prints the **join URL** a
   second computer binds to — `wss://<host>/ws/<workspace id>`, the endpoint
   with this workspace's id on the end.

When that deployment starts on empty hub data, the hub also creates its own
default workspace. It is distinct from the UUID this machine brought, and
claiming covers only that default workspace. The brought workspace keeps
host-only first-admin setup. Neither `ub remote init` nor `ub remote join`
adopts an existing workspace as the default.

Every step is idempotent: re-running `ub remote init` against a host it already
stood up adds no second deploy key and re-clones nothing. The re-run locks that
checkout continuously while it fast-forwards, replaces `.env`, rebuilds, and
records the deployed commit, so it cannot interleave with another re-run or
`ub remote update`. A contending re-run refuses as an operational failure.

That guarantee starts once the checkout already exists. The first invocation
creates the directory before it writes `.env` and builds, so do not overlap a
second invocation with that initial stand-up.

### Updating a checkout host

**The host does not update itself.** It stays on the commit it was last deployed
at until somebody deploys another one. Nothing is scheduled: no timer, no
webhook, no polling loop (owner decision, 2026-08-25 — an unattended updater
would apply a commit that changes wire semantics to production with nobody
present).

One command, from your own machine, run by you or by an agent session over SSH:

```sh
ub remote update uberblick@box.tailnet.ts.net
```

It runs `remote-update.sh` in the host's checkout — the same script you would
run by hand there — and reports either "up to date" or the commit it moved to.
A `flock` on the checkout keeps every deployment of an existing checkout — this
script or an `ub remote init` re-run, whichever sessions or users they run as —
from interleaving. Updater contention remains the successful no-op "already
running; nothing to do"; an explicit init re-run that cannot apply its
configuration refuses non-zero. A second checkout on the same host remains free
to deploy itself, and a host that cannot take a lock at all refuses non-zero
rather than reporting an update it never ran as success.

Both an update and an init re-run preserve the host's `HUB_GITHUB_CLIENT_ID`.
The re-run reads that setting under the checkout lock rather than copying it
from the machine running init.

**When to update:** when a merged change is one you want live — a fix you are
waiting on, a feature you are about to demonstrate, a deployment you are about
to verify. Deploy while you are present to watch it, never as the last thing
before walking away.

**The wire-semantics rule.** A change to what travels over the socket — the auth
token's shape or claims, the sync protocol, the room key, the served
`/uberblick-config.json` contract — breaks every client still on the old code.
Deploy such a change and update the clients in the **same sitting**: after
`ub remote update`, pull `main` on each machine that syncs to this hub (and
reload every open browser tab, which takes its bundle and its configuration from
the host). If you cannot finish both halves now, do neither now.

Nothing is deployed *from* your checkout: the host fetches `origin/main` itself
and resets to it, so what runs there is always a commit that is on `main`.
The updater compares against `refs/uberblick/deployed`, which moves only after a
build exits 0 — never against `HEAD`. A commit whose build fails is therefore
retried on the next run rather than remembered as deployed, which is what keeps
one bad commit from wedging the host with its containers on the old code.
`git reset --hard` discards host-local edits to **tracked** files, deliberately —
the host mirrors `main` and is not a place to edit — and prints what it
discarded. The host's `.env` is untracked and survives; nothing runs `git clean`.
