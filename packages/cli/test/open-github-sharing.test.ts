import { createServer } from "node:http";
import { createMcpEngine, collectServingSyncStatus, resolveMcpConfig, type McpConfig } from "@uberblick/mcp-server";
import { appendBlock, docRev, exportMarkdown, getBlocksFragment, getMetaMap, githubItemKey, githubItemUrl, initDoc,
  listDirectory, readGitHubItemObservations, upsertDirectoryEntry } from "@uberblick/schema";
import { wrapToken } from "@uberblick/schema/protocol";
import { afterAll, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { localBrowserKey } from "../src/browser-key.js";
import { createApiAuthenticator, serveBoundRequest } from "../src/open-api.js";
import type { GitHubItemStateReading } from "../src/open-github-items.js";
import { createBrowserAccess } from "../src/open-session.js";
import { BrowserReplicas, browserWorkspaces } from "../src/open-workspaces.js";
import { freePort, removeTempDirs, sandbox, type Sandbox } from "./helpers.js";

const WORKSPACE = "5c02018f-8a8d-4f4c-8467-211785e56b7e";
const PAGE = "c61fb7fc-c0b9-4af0-bd19-267f9d8ed136";
const ITEM = githubItemUrl("https://github.com/uberblick-ai/uberblick-2/issues/2437")!;
const ITEM_KEY = githubItemKey(ITEM);

afterAll(removeTempDirs);

async function serve(box: Sandbox, config: McpConfig, read: () => Promise<GitHubItemStateReading>) {
  const engine = await createMcpEngine(config, { serving: true });
  const workspaces = browserWorkspaces({ workspaceId: WORKSPACE, hubUrl: null }, config, box.env, () => {});
  const replicas = new BrowserReplicas(workspaces, engine, () => {});
  const key = localBrowserKey(WORKSPACE, box.env);
  const access = await createBrowserAccess(new Map([[WORKSPACE, key]]), box.env);
  const authenticate = await createApiAuthenticator(workspaces);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer((request, response) => serveBoundRequest({
    request, response, replicas, authenticate, access, env: box.env,
    expectedHost: `127.0.0.1:${port}`, expectedOrigin: origin, root: box.cwd,
    statusForWorkspace: () => collectServingSyncStatus(engine, []),
    availableUpdate: () => null, document: () => "{}", githubItems: { read, async stop() {} },
  }));
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  const token = await access.roomToken(WORKSPACE, "github-sharing-test");
  const post = (headers: Record<string, string>) => fetch(`${origin}/api/github-item-states`, {
    method: "POST", headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify({ items: [ITEM] }),
  });
  return {
    engine, replicas,
    unauthenticated: () => post({}),
    read: () => post({ authorization: `Bearer ${wrapToken(token!)}`, "x-uberblick-session": access.sessions.issue() }),
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await replicas.close();
    },
  };
}

it("records authenticated GitHub readings outside pages and keeps the local record across restart", async () => {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
  const config = { ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" }), authSecret: null };
  const seenAt = Date.now();
  let reading: GitHubItemStateReading = {
    states: { [ITEM_KEY]: "issue-completed" }, refreshAfterMs: { [ITEM_KEY]: 3_600_000 },
    observations: { [ITEM_KEY]: { state: "issue-completed", seenAt, isPublic: true } },
  };
  const lookup = vi.fn(async () => reading);
  const app = await serve(box, config, lookup);
  try {
    const page = app.engine.replicas.replica(PAGE).doc;
    initDoc(page, { uuid: PAGE, title: "GitHub evidence" });
    appendBlock(page, { type: "paragraph", text: "An ordinary page" });
    upsertDirectoryEntry(app.engine.replicas.directory().doc, { uuid: PAGE, title: "GitHub evidence" });
    await app.engine.replicas.settle();
    const pageBytes = Y.encodeStateAsUpdate(page);
    const pageRevision = docRev(page);
    const markdown = exportMarkdown(page);
    const directory = listDirectory(app.engine.replicas.directory().doc);
    const record = app.engine.replicas.githubItems().doc;
    const undo = new Y.UndoManager([getMetaMap(page), getBlocksFragment(page)]);
    try {
      expect((await app.unauthenticated()).status).toBe(401);
      expect(lookup).not.toHaveBeenCalled();
      expect(readGitHubItemObservations(record).size).toBe(0);

      const answer = await app.read();
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ states: reading.states, refreshAfterMs: reading.refreshAfterMs });
      expect(readGitHubItemObservations(record).get(ITEM_KEY)).toEqual(reading.observations[ITEM_KEY]);
      expect(undo.undoStack).toHaveLength(0);
      const logSize = app.engine.store.logSize();

      reading = { ...reading, observations: { [ITEM_KEY]: { state: "issue-completed", seenAt: seenAt + 60_000, isPublic: true } } };
      expect((await app.read()).status).toBe(200);
      expect(app.engine.store.logSize()).toBe(logSize);
      expect(readGitHubItemObservations(record).get(ITEM_KEY)?.seenAt).toBe(seenAt);

      reading = { states: { [ITEM_KEY]: null }, refreshAfterMs: { [ITEM_KEY]: 300_000 }, observations: {} };
      expect((await app.read()).status).toBe(200);
      expect(app.engine.store.logSize()).toBe(logSize);
      expect(readGitHubItemObservations(record).get(ITEM_KEY)).toEqual({ state: "issue-completed", seenAt, isPublic: true });
      expect(Y.encodeStateAsUpdate(page)).toEqual(pageBytes);
      expect(docRev(page)).toBe(pageRevision);
      expect(exportMarkdown(page)).toBe(markdown);
      expect(listDirectory(app.engine.replicas.directory().doc)).toEqual(directory);
    } finally { undo.destroy(); }
  } finally { await app.close(); }

  const restarted = await createMcpEngine(config, { serving: true });
  try {
    expect(readGitHubItemObservations(restarted.replicas.githubItems().doc).get(ITEM_KEY))
      .toEqual({ state: "issue-completed", seenAt, isPublic: true });
    expect(listDirectory(restarted.replicas.directory().doc).map(entry => entry.uuid)).toEqual([PAGE]);
  } finally { await restarted.close(); }
});

it("returns the reader's own state when the optional workspace record is unavailable", async () => {
  const box = sandbox({ projectBinding: { workspaceId: WORKSPACE, hubUrl: null } });
  const config = { ...resolveMcpConfig({ ...box.env, WORKSPACE_ID: WORKSPACE, UB_HUB_URL: "local" }), authSecret: null };
  const reading: GitHubItemStateReading = {
    states: { [ITEM_KEY]: "issue-open" }, refreshAfterMs: { [ITEM_KEY]: 300_000 },
    observations: { [ITEM_KEY]: { state: "issue-open", seenAt: Date.now(), isPublic: false } },
  };
  const app = await serve(box, config, async () => reading);
  const unavailable = vi.spyOn(app.replicas, "prepare").mockRejectedValue(new Error("replica unavailable"));
  try {
    const answer = await app.read();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ states: reading.states, refreshAfterMs: reading.refreshAfterMs });
    expect(readGitHubItemObservations(app.engine.replicas.githubItems().doc).size).toBe(0);
  } finally { unavailable.mockRestore(); await app.close(); }
});
