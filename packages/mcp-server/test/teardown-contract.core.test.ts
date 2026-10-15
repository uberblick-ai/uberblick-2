

import { afterEach, expect, it } from "vitest";
import { cleanupTestResources } from "./core-helpers.js";
import { drainWaits, waitUntil } from "./lifecycle.js";

const clients: (() => Promise<unknown>)[] = [];
const peers: (() => Promise<unknown>)[] = [];
const hubs: (() => Promise<unknown>)[] = [];
afterEach(() => cleanupTestResources({
  clients: clients.splice(0), peers: peers.splice(0), hubs: hubs.splice(0),
}));

it("awaits each cleanup phase and preserves every failure while closing the rest", async () => {
  const closed: string[] = [];
  const clientError = new Error("client close rejected");
  const hubError = new Error("hub stop rejected");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const cleaning = cleanupTestResources({
    clients: [async () => { await held; closed.push("client"); throw clientError; }],
    peers: [() => { closed.push("peer"); }],
    hubs: [() => { closed.push("hub"); throw hubError; }, () => { closed.push("listener"); }],
    after: [() => { closed.push("directory"); }],
  });
  const failed = expect(cleaning).rejects.toMatchObject({ errors: [clientError, hubError] });
  await Promise.resolve();
  expect(closed).toEqual([]);
  release();
  await failed;
  expect(closed).toEqual(["client", "peer", "hub", "listener", "directory"]);
});

it("drains an in-flight predicate before cleanup closes its resource", async () => {
  let release!: () => void;
  let entered!: () => void;
  let calls = 0;
  let closed = false;
  const held = new Promise<boolean>((resolve) => { release = () => resolve(false); });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const polling = waitUntil("an unfinished predicate", async () => {
    calls += 1;
    entered();
    return held;
  });
  const observed = polling.then(() => undefined, () => undefined);
  await started;
  const cleaning = cleanupTestResources({ clients: [() => { closed = true; }] });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await cleaning;
  await observed;
  expect(closed).toBe(true);
  expect(calls).toBe(1);
});

it("stops idle polling before the first client closes", async () => {
  let calls = 0;
  const polling = waitUntil("a condition that never arrives", () => { calls += 1; return false; });
  const observed = polling.then(() => undefined, () => undefined);
  await drainWaits();
  const beforeClose = calls;
  await cleanupTestResources({ clients: [() => { expect(calls).toBe(beforeClose); }] });
  await observed;
  expect(calls).toBe(beforeClose);
});

it("reports a predicate failure during teardown and still closes clients", async () => {
  const failure = new Error("the active predicate failed");
  let reject!: (reason: unknown) => void;
  let closed = false;
  const held = new Promise<boolean>((_resolve, fail) => { reject = fail; });
  const polling = waitUntil("a failing predicate", () => held);
  const observed = expect(polling).rejects.toBe(failure);
  const cleaning = cleanupTestResources({ clients: [() => { closed = true; }] });
  const failed = expect(cleaning).rejects.toMatchObject({ errors: [{ errors: [failure] }] });
  reject(failure);
  await failed;
  await observed;
  expect(closed).toBe(true);
});
