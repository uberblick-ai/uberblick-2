/** A settled configuration without an endpoint cannot open rooms. */
import { renderSettled } from "./react-render.js";
import { afterEach, expect, it, vi } from "vitest";
import { acquireRoom } from "../src/collab/rooms.js";
import type { ClientConfig } from "../src/config.js";
import { resolveClientConfig } from "../src/config.js";
import { useHubEndpoint, useRoom } from "../src/ui/hooks.js";

vi.mock("../src/config.js", () => ({ resolveClientConfig: vi.fn() }));
vi.mock("../src/collab/rooms.js", () => ({ acquireRoom: vi.fn() }));

const ROOM = "00000000-0000-4000-8000-000000000001/_directory";
const IDENTITY = { name: "synthetic", color: "#006699" };

function Probe() {
  const ready = useHubEndpoint();
  useRoom(ready ? ROOM : null, IDENTITY);
  return <output>{ready ? "ready" : "waiting"}</output>;
}

function configuration(hubUrl: string): ClientConfig {
  return {
    hubUrl, hubUrlSource: "document", workspaces: [], workspacesSource: "document",
    hubAuthToken: "synthetic-token", localServing: null,
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

it("keeps the room gate closed when the served endpoint could not be resolved", async () => {
  vi.mocked(resolveClientConfig).mockResolvedValue(configuration(""));
  const { container: host } = await renderSettled(<Probe />);
  expect(host.textContent).toBe("waiting");
  expect(acquireRoom).not.toHaveBeenCalled();
});

it("admits rooms when a served endpoint resolves and releases them on unmount", async () => {
  vi.mocked(resolveClientConfig).mockResolvedValue(configuration("wss://synthetic.tailnet.ts.net/ws"));
  const release = vi.fn();
  vi.mocked(acquireRoom).mockReturnValue({
    connection: { room: ROOM } as ReturnType<typeof acquireRoom>["connection"], release,
  });
  const view = await renderSettled(<Probe />);
  const host = view.container;
  expect(host.textContent).toBe("ready");
  expect(acquireRoom).toHaveBeenCalledExactlyOnceWith(ROOM, IDENTITY);
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});
