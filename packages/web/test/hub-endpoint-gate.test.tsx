/** A settled configuration without an endpoint cannot open rooms. */
import { act, render, renderSettled } from "./react-render.js";
import { afterEach, expect, it, vi } from "vitest";
import { acquireRoom } from "../src/collab/rooms.js";
import type { ClientConfig } from "../src/config.js";
import { defaultPresenceName, resolveClientConfig } from "../src/config.js";
import { useHubEndpoint, useIdentity, useRoom, useSetting } from "../src/ui/hooks.js";
import { setSetting } from "../src/settings.js";

vi.mock("../src/config.js", () => ({ defaultPresenceName: vi.fn(), resolveClientConfig: vi.fn() }));
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
  vi.unstubAllGlobals();
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

it("waits for the served name before acquiring a room and keeps that default across later renames", async () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  let settle!: (config: ClientConfig) => void;
  vi.mocked(resolveClientConfig).mockReturnValue(new Promise((resolve) => { settle = resolve; }));
  const release = vi.fn();
  vi.mocked(acquireRoom).mockReturnValue({
    connection: { room: ROOM } as ReturnType<typeof acquireRoom>["connection"], release,
  });
  const factory = vi.fn(() => IDENTITY);
  function NamedProbe({ room = ROOM }: { room?: string }) {
    const ready = useHubEndpoint();
    const identity = useIdentity(factory, ready ? defaultPresenceName() : null);
    const chosenName = useSetting("presenceName");
    useRoom(ready ? room : null, identity);
    return <output>{chosenName ?? identity.name}</output>;
  }
  const view = render(<NamedProbe />);
  expect(acquireRoom).not.toHaveBeenCalled();
  expect(defaultPresenceName).not.toHaveBeenCalled();
  vi.mocked(defaultPresenceName).mockReturnValue("Git Editor");
  await act(async () => { settle({ ...configuration("ws://127.0.0.1:4321"), defaultPresenceName: "Git Editor" }); });
  expect(acquireRoom).toHaveBeenCalledExactlyOnceWith(ROOM, { ...IDENTITY, name: "Git Editor" });
  expect(view.container.textContent).toBe("Git Editor");

  act(() => setSetting("presenceName", "Chosen Editor"));
  expect(view.container.textContent).toBe("Chosen Editor");
  act(() => setSetting("presenceName", " "));
  expect(view.container.textContent).toBe("Git Editor");
  expect(acquireRoom).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledTimes(1);

  act(() => setSetting("presenceName", "Chosen Editor"));
  const laterRoom = "00000000-0000-4000-8000-000000000001/later";
  vi.mocked(acquireRoom).mockReturnValue({
    connection: { room: laterRoom } as ReturnType<typeof acquireRoom>["connection"], release,
  });
  view.rerender(<NamedProbe room={laterRoom} />);
  expect(acquireRoom).toHaveBeenLastCalledWith(laterRoom, { ...IDENTITY, name: "Git Editor" });
  act(() => setSetting("presenceName", ""));
  expect(view.container.textContent).toBe("Git Editor");
  expect(acquireRoom).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(release).toHaveBeenCalledTimes(2);
});
