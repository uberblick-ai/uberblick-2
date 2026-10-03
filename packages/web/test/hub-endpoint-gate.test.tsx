/** A settled configuration without an endpoint cannot open rooms. */
import { act } from "react";
import { createRoot } from "react-dom/client";
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
  document.body.replaceChildren();
});

it("keeps the room gate closed when the served endpoint could not be resolved", async () => {
  vi.mocked(resolveClientConfig).mockResolvedValue(configuration(""));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Probe />); });
    expect(host.textContent).toBe("waiting");
    expect(acquireRoom).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

it("admits rooms when a served endpoint resolves and releases them on unmount", async () => {
  vi.mocked(resolveClientConfig).mockResolvedValue(configuration("wss://synthetic.tailnet.ts.net/ws"));
  const release = vi.fn();
  vi.mocked(acquireRoom).mockReturnValue({
    connection: { room: ROOM } as ReturnType<typeof acquireRoom>["connection"], release,
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<Probe />); });
    expect(host.textContent).toBe("ready");
    expect(acquireRoom).toHaveBeenCalledExactlyOnceWith(ROOM, IDENTITY);
  } finally {
    act(() => root.unmount());
  }
  expect(release).toHaveBeenCalledOnce();
});
