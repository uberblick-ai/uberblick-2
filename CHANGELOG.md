# Changelog

User-visible changes in each release of the `ub` client and the hub, newest
first. The first paragraph of each release is its summary; uberblick.ai shows
the five newest. Upgrade steps appear only when a release needs more than
updating the client and the hub.

## v0.4.8 — 2026-10-20

Ablauf diagrams drawn in the editor, an Alter decision dialog on decision topics, and a hub that runs and updates with plain Docker Compose from release downloads, replacing `ub hub`.

### Breaking

- `ub hub` is removed. A hub it deployed switches to the release's Compose files; see REMOTE.md, "Move an existing release deployment to downloaded files" (#1994).

### Added

- Ablauf fences render as diagrams inline in the editor, in the host's colours (#1985, #1995).
- Decision topics offer an Alter decision dialog with a rich answer editor (#1989, #1992).
- Each hub release publishes `compose.yml`, `remote.env.example`, `remote.https.yml` and `remote.tailscale.yml` as release downloads (#1993).
- Charts draw series as grouped bars or behind lines, take series axis ranges and reference lines, and colour a sole series' axis numbers to match it (#1965, #1975, #1984).
- Curated inline icons render from literal shortcode text in prose and card labels (#1974).
- MCP writes nested and ordered list items (#1968).
- `ub status` shows the client and hub versions together (#1962).
- The document sync details compare the page with its code checks (#2002).
- The web app, hub and uberblick.ai have the ub favicon and app icons (#1958).

### Changed

- Hub images back up the database before a newer release opens it, refuse a database written by a newer release, and declare container health (#1990).
- Web document search matches word fragments (#1945).
- Tag names are accepted in any case when created in the web app and when selected over MCP (#1973).
- Every record in a decision topic carries the topic's one title, and decision history uses simpler indicators (#1997, #1998).
- Notifications use Sonner's standard behaviour (#1952).
- Table keyboard shortcuts are removed (#1950).
- GitHub pills show the link cursor on hover (#1967).

## v0.4.7 — 2026-10-19

`ub workspace fork`, device credentials that expire after 30 days and renew on their own, table columns resized by dragging, one `ub status` report for workspace and sync, and hub admins appointed by the host operator.

### Breaking

- Device-created signing keys replace earlier HMAC credentials, which the upgraded
  hub revokes. Update the hub and every client to the matching protocol together,
  then run `ub auth login <hub-origin>` again on every computer and unattended
  agent host. Restart MCP servers and `ub open`, and reload host-served pages.
  See the [device-created-key upgrade procedure](https://github.com/uberblick-ai/uberblick-2/blob/v0.4.7/REMOTE.md#upgrade-an-existing-deployment-to-device-created-keys) (#1918).
- `ub workspace member add` asks for confirmation; pass `--yes` to grant without a terminal (#1943).

### Added

- `ub workspace fork` copies the selected workspace into an independent local workspace (#1941).
- Ordinary table columns resize by dragging (#1925).
- Hub operators appoint hub admins with `ub-hub hub-admin add` on the host (#1919).
- Document sync activity shows as an expanding green ring (#1884).
- Copy link sits beside the document actions (#1927).

### Changed

- `ub status` reports workspace and sync together, and `ub workspace list` aligns its columns (#1940, #1942, #1944).
- Workspace settings are separate from personal settings (#1937).
- Permanent deletion on the hub archives first, and `ub open` uses launch-session tokens (#1948).
- Restoring a hub database reports the access changes it makes (#1932).
- Workspaces with unrecorded replicas are usable locally (#1938).
- Code-check-only writes leave a document's edited time unchanged (#1926).
- Device credentials expire after 30 days, and clients renew them after 15 (#1929).
- A project binding that would move an existing replica to another hub is refused (#1909).

### Fixed

- Device signing keys stay off the hub and credential reuse is detected (#1918).
- Replayed or long-lived management request proofs are refused (#1915).
- Hub WebSocket messages, room admission and library logs are bounded (#1922).
- Large directory updates no longer do quadratic lookup work (#1914).
- Malformed synced document IDs are skipped and room identity is preserved (#1910).

## v0.4.6 — 2026-10-18

A search-first command palette, local workspace removal, notices of recent device sign-ins, and a hub that authenticates each room before any sync traffic.

### Breaking

- Clients refuse unencrypted connections to hubs that are not on loopback (#1901).

### Added

- A search-first command palette for the workspace (#1874).
- `ub workspace remove` removes a local workspace; MCP refuses writes to it afterwards (#1849).
- `ub status` and `ub open` tell you about recent device sign-ins (#1904).

### Changed

- All documents switches types with tabs and keeps search and filters in one row; decision rows stay on one line with a stage pill (#1819, #1827).
- The decision topic page and page decisions are more compact (#1821, #1848).
- The "On this page" outline is removed (#1818).
- Document actions, tag trigger, table headers, page insets and surfaces are more compact and consistent (#1875, #1876, #1877, #1878, #1880).

### Fixed

- The hub authenticates each room before clients apply or send sync traffic (#1900).
- Settings sync requires workspace-admin authority (#1882).
- Hub sign-in starts and public account lookups are bounded (#1903).
- Web dependency security advisories are resolved (#1829).

## v0.4.5 — 2026-10-16

Mermaid blocks removed, one Content-Security-Policy for the web app, Figma titles before the viewer loads, quiet `ub open` output with `--verbose`, simpler member management.

### Breaking

- Mermaid blocks and their renderer are removed (#1815).

### Added

- Live Figma blocks with bounded viewers and caption editing; titles and private-file placeholders show before a viewer loads (#1783, #1806).
- `ub open --verbose` prints hub, sync and startup details; normal output stays short (#1813).
- A card can be removed from its hover controls (#1811).
- The hub image ships `ub-hub` operator commands (#1711).
- Archived documents can be deleted permanently across hubs and replicas (#1779).
- Decision topic titles are editable without losing answer approval (#1792).

### Changed

- The web app enforces one shared Content-Security-Policy (#1816).
- Member management saves a role as soon as it is picked (#1803).
- Settings are grouped by Workspace, User and Hub, with a concise Workspace General page (#1799, #1800).
- A quieter document header with a sync dot and revision, neutral ink for badges and links, one type scale, unified block frames, and calmer dialogs and toasts (#1746, #1749, #1750, #1752, #1790, #1791).
- The sidebar leads with documents, shows the workspace name and location, and reports sync problems in its footer (#1748, #1787).
- Decision history is a compact timeline, and the selected record's RFC shows below its answer (#1784, #1794).
- TL;DR is a neutral index card, and the Contents pill becomes an On this page row (#1797, #1804).

## v0.4.4 — 2026-10-14

Hub administration with workspace suspension, decision topics with current answers and history, GitHub links as compact pills, Mermaid diagrams, and sortable data tables.

### Added

- Hub administration; new workspace promotions require it, and admins can suspend and restore workspaces (#1641, #1659).
- When no hub admin exists, the hub appoints the oldest workspace member (#1729).
- Decision topics show current answers with selectable history, one row per topic with a state filter, and related Decisions below regular pages (#1632, #1647, #1648).
- GitHub issue and pull request links show as compact editor pills with the right icon (#1681, #1683, #1727).
- Mermaid blocks render as diagrams (#1642).
- Generated data tables sort through their column headers, and table columns move left or right from the column menu (#1615, #1699).
- Card blocks take several styled link buttons (#1639, #1661).
- `ub data get` and `ub data update` read and write document data from files (#1644).
- MCP finds documents with unresolved comment threads (#1706).

### Changed

- Search matches any word, ranks titles higher and shows current record states (#1665).
- Figma references are normalized in Markdown and MCP (#1660).
- Hub sign-in uses a separate GitHub browser session (#1685).
- `ub auth status` checks current hub authority (#1697).
- The requirement lifecycle is removed from documents (#1651).

## v0.4.3 — 2026-10-12

Native card blocks in the editor and over MCP, line chart panels, decisions with short answers and RFC discussions over MCP, table columns deleted from a top-edge menu.

### Added

- Native prose card blocks in the editor and over MCP (#1622).
- Opt-in panels for line charts, and record limits for charts and data tables (#1598, #1623).
- Decision records take short answers and connect RFC discussions through MCP (#1628, #1629).
- Table columns are deleted from a top-edge menu, and document typeahead works in editable table cells (#1625, #1626).
- Wireframe code blocks show live previews (#1602, #1611).
- `ub hub` manages a local Docker hub deployment (#1600).

### Changed

- One presence avatar per agent session (#1599).
- `ub doctor` distinguishes the web server from the local hub (#1616).

## v0.4.2 — 2026-10-11

The corpus stays in step with merged code without erasing intent; the MCP docs explain when a decision record is useful.

### Breaking

- `ub mcp install` requires a client and supports Claude and Codex only (#1538, #1543).
- The `mcp` command group drops `--project` (#1550).
- `ub open` rejects the hidden `--browser` flag (#1558).
- MCP's six metadata setters are replaced by `set_metadata` (#1513).

### Added

- MCP explains when a decision record is useful (#1604).
- Your devices lists registered hostnames (#1533).
- The presence name defaults to your git name and is editable (#1567).
- `ub update` shows Homebrew versions and restart guidance (#1568).

### Changed

- `ub status` shows the short sync report, and `ub workspace list` shows the recorded hub or local (#1520, #1532).
- `ub doctor` names the workspace, the account, recorded hub connection failures and one-line fixes (#1525, #1526).
- The client checks the hub's sync protocol before GitHub sign-in (#1586).
- Workspace promotion requires sign-in (#1537).

### Fixed

- MCP reports the installed release identity and sanitizes resource and persistence failures (#1516, #1518).
- `ub auth logout` escapes control characters in usernames (#1522).
- Group actions and pins are sized for coarse pointers (#1487).

## v0.4.1 — 2026-10-09

The client and the hub Docker image released together.

### Breaking

- `ub init` and `ub env` are removed; `ub workspace create` and `ub open` set up local secrets (#1458, #1470).
- `ub update` and `ub open` drop the checkout install mode (#1388).

### Added

- The client and the hub image are released together at one version (#1478).
- Documents own validated data, served through dedicated MCP tools, with live line chart blocks and generated data tables (#1421, #1425, #1432, #1463, #1476).
- MCP help resources and `get_help` (#1457).
- TL;DR summaries are editable inline (#1445).
- Code block headers have a searchable language dropdown (#1427).
- Tables get quiet insertion controls on their borders, row menus, and rows reordered from their handles (#1382, #1396, #1449).
- Comment threads on table cell text (#1378).
- `ub open` switches between this machine's workspaces and manages workspace access (#1316, #1384).
- `ub status` shows this machine's last hub sync, and `ub workspace status` reports the workspace (#1362, #1409).

### Changed

- Shared transient and sticky notifications for copy and settings feedback (#1461, #1493).
- Onboarding output is shorter and shows state-aware next actions (#1406).
- Line charts get calendar ticks, axes labelled at plotted observations, and non-negative axes that start at zero (#1469, #1481, #1502).

### Fixed

- Document controls, sidebar navigation and the Threads close button are usable on iPad (#1480, #1490, #1492).
- Departed agents' avatars stay with their edit cursors (#1488).
- Table revisions update on nested edits, and short generated values stay on one line (#1482, #1500).

## v0.4.0 — 2026-10-06

`ub doctor` reports seven setup checks with fixes, workspace members managed from the CLI, document links and inline Markdown in table cells, and `ub open` on port 13379.

### Breaking

- `ub open` defaults to port 13379 (#1321).
- The source-checkout hub deployment stack is removed (#1357).

### Added

- `ub workspace member` adds members, lists them, changes roles and removes access (#1317).
- Document links and inline Markdown render in table cells, and selected text in one cell formats with the usual popup (#1328, #1348).
- `ub status` shows the stored GitHub account (#1360).

### Changed

- `ub doctor` is observational, reports seven setup checks, and warns about unreachable hubs with fixes (#1350, #1353).
- `ub auth logout` and a replacement login revoke the device, issued credentials name their workspaces, and `ub auth status` explains missing workspace access (#1331, #1334, #1343).
- `ub workspace list` shows local workspace names (#1315).
- Decided decision records are read-only in the web editor (#1319).

### Fixed

- Inline Markdown marks apply after opening punctuation (#1322).

## v0.3.0 — 2026-10-05

Local workspaces promoted to a hub, projects bound to explicit workspaces and hubs, released Docker hubs with optional Tailscale, and editable structured table cells.

### Added

- `ub workspace create` makes a local workspace and `ub workspace promote` moves it to a hub, open to current workspace members (#1270, #1273).
- Projects and MCP entries bind to explicit workspaces and hubs; `.uberblick.json` picks the workspace for the MCP server (#1269).
- Released Docker hubs run with optional Tailscale (#1259).
- Authenticated member and device management on the hub, and direct workspace grants to confirmed GitHub accounts (#1255, #1309).
- Structured table cells are edited directly (#1214).

### Changed

- `ub auth login` opens the GitHub approval page (#1313).
- Remote hub visitors are guided through claiming and local access (#1256).

## v0.2.9 — 2026-10-04

GitHub sign-in with revocable device credentials, hub-owned memberships and roles, hubs released as Docker images, named workspaces, and touch-ready editor controls.

### Breaking

- Remote hubs and clients switch to device credentials. Before switching either
  side, configure GitHub sign-in, run host-only first-admin setup for each existing
  workspace while retaining its UUID, and run `ub auth login <hub-origin>` on every
  computer and unattended agent host. Update the hub and all clients to the matching
  protocol together, restart MCP servers and `ub open`, and reload host-served pages.
  See the [device-credential upgrade procedure](https://github.com/uberblick-ai/uberblick-2/blob/v0.2.9/REMOTE.md#upgrade-an-existing-deployment-to-device-credentials) (#1220).

### Added

- `ub auth login`, `ub auth status` and `ub auth logout` sign in to remote hubs with the GitHub device flow (#1128, #1130).
- Hub-owned device credentials that renew for current memberships, and hub-owned workspace memberships and roles (#1107, #1125, #1159, #1166).
- A hub operator establishes a workspace's first admin, and fresh hubs are initialized and claimed through CLI login (#1129, #1209).
- The hub is released as immutable Docker images (#1177).
- Workspaces are named and renamed in settings (#1122).
- Homebrew installs on Linux x86_64 (#1043).
- `ub open` serves local-only workspaces (#1163).

### Changed

- Editor insertion and selection controls work on touch, with native editor keys and accessible caret menus (#1116, #1127, #1198).
- The sidebar uses a standard header for workspace switching, drags rows directly, animates collapse, and becomes a modal drawer below 1280px (#1046, #1113, #1124, #1164).
- Archive confirmation uses an alert dialog (#1187).
- Decided decision records are read-only over MCP, and records are indexed by linked GitHub issue or pull request (#1175, #1186).

### Fixed

- Document menu states and rendered text contrast (#1126).
- External editor links open while keeping the selection (#1118).
- IME composition in comment and group-name fields (#1117).

## v0.2.0 — 2026-10-01

Agent delivery moves out of `ub` into ub-agents.

### Breaking

- `ub agents` and `ub launch` are removed (#1011).
- The ablauf integration is removed; mermaid blocks show their source again (#1013).

## v0.1.1 — 2026-09-25

A remote join retries its first connection.

### Fixed

- The initial remote join connection is retried once (#998).

## v0.1.0 — 2026-09-13

The first release: a local-first, CRDT-backed document system that agents read and write over MCP and people edit in the browser.

### Added

- Yjs documents synced through a Hocuspocus hub with SQLite persistence.
- An MCP server with a local SQLite mirror, full-text search, tags and backlinks.
- A Tiptap web editor served by `ub open`.
- The `ub` CLI: `ub init`, `ub status`, `ub doctor`, `ub mcp serve` and `ub mcp install`, `ub remote init`, `ub remote join` and `ub remote update`, `ub workspace list` and `ub workspace use`, and `ub update`.
