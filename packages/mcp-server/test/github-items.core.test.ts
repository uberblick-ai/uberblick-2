import { afterEach, expect, it } from "vitest";
import { initDoc, listDirectory, readGitHubItemObservations } from "@uberblick/schema";
import * as Y from "yjs";
import { openWorkspaceReplicas, type WorkspaceReplicaSet } from "../src/workspace-replicas.js";
import { cleanupTestResources, testConfig } from "./core-helpers.js";

const workspaces: WorkspaceReplicaSet[] = [];
afterEach(async () => {
  await cleanupTestResources({ clients: workspaces.splice(0).map(workspace => () => workspace.close()) });
});

it("keeps local GitHub observations outside document state and the directory", () => {
  const workspace = openWorkspaceReplicas(testConfig(), { hubFree: true });
  workspaces.push(workspace);
  const uuid = "8011fa80-13bc-4229-9b94-a0aa61c824c1";
  const page = workspace.replicas.replica(uuid);
  initDoc(page.doc, { uuid, title: "Page with a GitHub link" });
  const pageState = Y.encodeStateAsUpdate(page.doc);
  const directoryState = Y.encodeStateAsUpdate(workspace.replicas.directory().doc);
  const observation = { state: "pull-merged", seenAt: Date.now(), isPublic: true } as const;
  workspace.replicas.recordGitHubItemObservations({ "acme/notes#1:pull-request": observation });
  expect(readGitHubItemObservations(workspace.replicas.githubItems().doc).get("acme/notes#1:pull-request")).toEqual(observation);
  expect(Y.encodeStateAsUpdate(page.doc)).toEqual(pageState);
  expect(Y.encodeStateAsUpdate(workspace.replicas.directory().doc)).toEqual(directoryState);
  expect(listDirectory(workspace.replicas.directory().doc).map(entry => entry.uuid)).toEqual([uuid]);
  expect(workspace.replicas.githubItems().doc.share.has("meta")).toBe(false);
  expect(workspace.replicas.githubItems().doc.share.has("blocks")).toBe(false);
});
