/** Shutdown budgets include admitted startup work and credential publication. */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setWorkspaceName } from "@uberblick/schema";
import { expect, it, vi } from "vitest";
import { createMcpServer } from "../src/server.js";
import { cleanupTestResources, hubUrl, startHub, testConfig, TEST_SECRET } from "./helpers.js";

it("uses only the budget left after draining admitted startup work and leaves time for credential publication", async () => {
  const hub = await startHub();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  hub.hocuspocus.configuration.extensions.push({ onLoadDocument: async () => { await held; } });
  const instance = createMcpServer(testConfig({
    authSecret: TEST_SECRET, hubUrl: hubUrl(hub.port), connectTimeoutMs: 30_000, syncTimeoutMs: 30_000,
  }));
  setWorkspaceName(instance.replicas.settings().doc, "Pending during startup");
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const waitForQuiet = instance.replicas.sync.waitForQuiet.bind(instance.replicas.sync);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let first = true;
  instance.replicas.sync.waitForQuiet = async (options) => {
    if (first) {
      first = false;
      enter();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return { caughtUp: false, reason: "deadline" };
    }
    return waitForQuiet(options);
  };
  const [, transport] = InMemoryTransport.createLinkedPair();
  const connecting = instance.connect(transport);
  let started = 0;
  instance.replicas.sync.waitForDeviceWork = async () => {
    if (performance.now() - started > 2_500) throw new Error("No time left for credential publication");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  };
  try {
    await entered;
    started = performance.now();
    await expect(instance.close(started + 5_000)).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5_000);
    await connecting;
    const stderr = diagnostic.mock.calls.flat().join("\n");
    expect(stderr).toContain("1 changes are still only local");
    expect(stderr).not.toContain("No time left for credential publication");
    expect(stdout).not.toHaveBeenCalled();
  } finally {
    release();
    await cleanupTestResources({
      clients: [() => instance.close(), () => transport.close(), () => connecting],
      hubs: [() => hub.stop()],
      after: [() => diagnostic.mockRestore(), () => stdout.mockRestore()],
    });
  }
}, 15_000);
