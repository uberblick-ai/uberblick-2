import { randomUUID } from "node:crypto";
import type { Hub } from "@uberblick/hub";
import { githubItemsRoom, initDoc, writeGitHubItemObservation } from "@uberblick/schema";
import { afterEach, expect, it } from "vitest";
import { compareCorpus, inspectRemote, isIdentical, syncWorkspace } from "../src/remote.js";
import { MirrorStore } from "../src/store.js";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { cleanupTestResources, hubUrl, LIVE_HUB_SETTLE, startHub, testConfig, TEST_SECRET } from "./helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  await cleanupTestResources({
    clients: workspaces.splice(0).map(workspace => () => workspace.close()),
    hubs: hubs.splice(0).map(hub => () => hub.stop()),
  });
});

it("uploads and fetches a complete corpus when an older hub refuses the optional GitHub room", async () => {
  const localConfig = testConfig();
  const local = openWorkspaceReplicas(localConfig, { hubFree: true });
  workspaces.push(local);
  const uuid = randomUUID();
  initDoc(local.replicas.replica(uuid).doc, { uuid, title: "Ordinary page" });
  writeGitHubItemObservation(local.replicas.githubItems().doc, "acme/notes#1:issue", {
    state: "issue-open", seenAt: Date.now(), isPublic: true,
  });
  await local.close();

  const hub = await startHub();
  hubs.push(hub);
  const optional = githubItemsRoom(localConfig.workspaceId);
  hub.hocuspocus.configuration.extensions.unshift({ onAuthenticate: async ({ documentName }) => {
    if (documentName === optional) throw Object.assign(new Error("unsupported optional room"), { reason: "room-name-invalid" });
  } });
  const remoteConfig = { ...localConfig, hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET, ...LIVE_HUB_SETTLE };
  const uploaded = await syncWorkspace(remoteConfig);
  expect(uploaded).toMatchObject({ hub: { status: "connected" }, complete: true, missing: [], unsettled: [] });
  expect(uploaded.hub.authRecovery).toBeUndefined();
  expect(uploaded.entries.map(entry => entry.uuid)).toEqual([uuid]);
  const readback = await inspectRemote(remoteConfig, { documents: true, workspace: true });
  expect(isIdentical(compareCorpus(uploaded.entries, readback.entries))).toBe(true);
  expect(isIdentical(compareCorpus(uploaded.workspace!, readback.workspace!))).toBe(true);

  const fetched = await syncWorkspace(testConfig({ hubUrl: hubUrl(hub.port), authSecret: TEST_SECRET, ...LIVE_HUB_SETTLE }));
  expect(fetched).toMatchObject({ hub: { status: "connected" }, complete: true, missing: [], unsettled: [] });
  expect(fetched.hub.authRecovery).toBeUndefined();
  expect(isIdentical(compareCorpus(uploaded.entries, fetched.entries))).toBe(true);
  expect(isIdentical(compareCorpus(uploaded.workspace!, fetched.workspace!))).toBe(true);

  const store = new MirrorStore(localConfig.databasePath, localConfig.workspaceId);
  try { expect(store.pendingRooms().map(room => room.room)).toContain(optional); }
  finally { store.close(); }
});
