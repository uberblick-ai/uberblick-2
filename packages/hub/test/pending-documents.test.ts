/**
 * The pending-document ceiling.
 *
 * The number itself is the library's, but *stating* it is the point: a hub that
 * inherits the limit inherits whatever a future `@hocuspocus/server` decides,
 * and this one terminates a whole websocket — every healthy room on it included
 * — when the limit is reached. So the hub names its own ceiling, and this file
 * is what keeps the name and the constructed server from drifting apart.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MAX_PENDING_DOCUMENTS } from "../src/config.js";
import type { Hub } from "../src/server.js";
import { removeTempDatabases, startHub } from "./helpers.js";

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) {
    await hub.stop();
  }
  removeTempDatabases();
});

async function hub(overrides: Parameters<typeof startHub>[0] = {}) {
  const started = await startHub(overrides);
  hubs.push(started);
  return started;
}

describe("pending-document ceiling", () => {
  it("is the hub's own number, and reaches the server", async () => {
    // Pinned: raising it is a decision about how much memory one unauthenticated
    // connection may make the hub allocate, not a knob to turn when a client
    // attaches too fast. See MAX_PENDING_DOCUMENTS.
    expect(MAX_PENDING_DOCUMENTS).toBe(100);

    const started = await hub();
    expect(started.server.configuration.maxPendingDocuments).toBe(
      MAX_PENDING_DOCUMENTS,
    );
  });

  it("leaves the two queue caps at the library's defaults", async () => {
    const started = await hub();

    // Bytes and messages buffered before auth are a property of how much a
    // client sends per room, not of how many rooms it opens — and nothing here
    // has measured either default to be wrong. An unmeasured number in the
    // config is one nobody can defend later, so these stay where they are and
    // this test says so out loud.
    expect(started.server.configuration.maxUnauthenticatedQueueSize).toBe(
      5 * 1024 * 1024,
    );
    expect(started.server.configuration.maxUnauthenticatedQueueMessages).toBe(
      1_000,
    );
  });

  it("takes an override, which is how a test can breach it in a few rooms", async () => {
    const started = await hub({ maxPendingDocuments: 5 });
    expect(started.server.configuration.maxPendingDocuments).toBe(5);
  });
});
