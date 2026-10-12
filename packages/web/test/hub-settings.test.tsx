import { act, renderSettled } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { AccessAction, AccessAnswer, HubAdmin, HubWorkspace } from "../src/shell/workspace-access.js";
import { HubSettings } from "../src/ui/settings/HubSettings.js";
import { useHubAdministration } from "../src/ui/settings/hub-administration.js";

const WORKSPACE = "53f04353-622b-4b14-8d71-366193d43c74";
const SERVING = { workspace: WORKSPACE, remoteHubUrl: "ws://bound.example", rebound: false };
const HUB = "https://bound.example";
const api = vi.fn<(action: AccessAction, signal: AbortSignal) => Promise<AccessAnswer>>();
vi.mock("../src/shell/workspace-access.js", () => ({ createWorkspaceAccessClient: () => api }));

const ADMIN: HubAdmin = { principalId: "person", githubAccountId: "1234", githubUsername: "person",
  workspaces: 0, lastSignedInAt: null, current: true };
const INVENTORY: HubWorkspace = { workspaceId: WORKSPACE, name: "Project", members: 2, admins: ["person"], status: "active" };

function Reading({ page }: { page: "hub-admins" | "hub-workspaces" }) {
  const administration = useHubAdministration(WORKSPACE, SERVING, "presence", "settings");
  return <>{administration.admin && <section aria-label="Hub">Hub</section>}
    <HubSettings page={page} administration={administration} /></>;
}

describe("complete hub settings inventories", () => {
  afterEach(() => vi.resetAllMocks());

  it("reads every administrator page with the same cancellation signal", async () => {
    api.mockImplementation(async (action) => {
      if (action.operation === "own-hub-role") return { status: "ok", role: "admin", hub: HUB };
      if (action.operation !== "list-hub-admins") throw new Error("Unexpected request");
      return action.cursor === undefined
        ? { status: "ok", hub: HUB, admins: [ADMIN], nextCursor: "other" }
        : { status: "ok", hub: HUB, admins: [ADMIN, { ...ADMIN, principalId: "other", githubUsername: "other", current: false }], nextCursor: null };
    });
    await renderSettled(<Reading page="hub-admins" />);
    const table = screen.getByRole("table", { name: "Hub admins" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const reads = api.mock.calls.filter(([action]) => action.operation === "list-hub-admins");
    expect(reads.map(([action]) => action)).toEqual([
      { operation: "list-hub-admins" }, { operation: "list-hub-admins", cursor: "other" },
    ]);
    expect(reads[0]?.[1]).toBe(reads[1]?.[1]);
  });

  it("joins workspace fragments while retaining every distinct administrator", async () => {
    api.mockImplementation(async (action) => {
      if (action.operation === "own-hub-role") return { status: "ok", role: "admin", hub: HUB };
      if (action.operation !== "list-hub-workspaces") throw new Error("Unexpected request");
      return action.cursor === undefined
        ? { status: "ok", hub: HUB, workspaces: [INVENTORY], nextCursor: "fragment" }
        : { status: "ok", hub: HUB, workspaces: [{ ...INVENTORY, admins: ["person", "other"] },
          { ...INVENTORY, workspaceId: "872b46d9-5b18-4fb1-84d5-de245c337e86", name: "Research", admins: [] }], nextCursor: null };
    });
    await renderSettled(<Reading page="hub-workspaces" />);
    const table = screen.getByRole("table", { name: "Hub workspaces" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const project = within(table).getAllByRole("row").find((row) => row.textContent?.includes("Project"));
    expect(project).toBeDefined();
    expect(within(project as HTMLElement).getAllByRole("cell")[1]?.textContent).toBe("@person, @other");
  });

  it("asks before suspending and restoring, then rereads the preserved inventory", async () => {
    let inventory = INVENTORY;
    api.mockImplementation(async (action) => {
      if (action.operation === "own-hub-role") return { status: "ok", role: "admin", hub: HUB };
      if (action.operation === "list-hub-workspaces") return { status: "ok", hub: HUB, workspaces: [inventory], nextCursor: null };
      if (action.operation !== "suspend-workspace" && action.operation !== "restore-workspace") throw new Error("Unexpected request");
      inventory = { ...inventory, status: action.operation === "suspend-workspace" ? "suspended" : "active" };
      return { status: "ok", hub: HUB, workspaceId: action.workspaceId, workspaceStatus: inventory.status };
    });
    await renderSettled(<Reading page="hub-workspaces" />);
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeDefined();
    expect(screen.getByRole("cell", { name: "Active" })).toBeDefined();
    expect(screen.getByText(/Suspending one stops its sync for everyone/)).toBeDefined();
    await act(async () => screen.getByRole("button", { name: "Suspend Project" }).click());
    const suspend = screen.getByRole("alertdialog", { name: 'Suspend "Project"?' });
    expect(suspend.textContent).toContain("downloaded copies remain usable");
    expect(api.mock.calls.some(([action]) => action.operation === "suspend-workspace")).toBe(false);
    await act(async () => within(suspend).getByRole("button", { name: "Cancel" }).click());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.mock.calls.some(([action]) => action.operation === "suspend-workspace")).toBe(false);
    await act(async () => screen.getByRole("button", { name: "Suspend Project" }).click());
    await act(async () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }).click());
    expect(screen.getByRole("cell", { name: "Suspended" })).toBeDefined();
    expect(screen.getByText("Project suspended.")).toBeDefined();
    expect(within(screen.getByRole("table")).getByText("@person")).toBeDefined();
    expect(api.mock.calls.filter(([action]) => action.operation === "suspend-workspace").map(([action]) => action))
      .toEqual([{ operation: "suspend-workspace", workspaceId: WORKSPACE }]);
    await act(async () => screen.getByRole("button", { name: "Restore Project" }).click());
    const restore = screen.getByRole("alertdialog", { name: 'Restore "Project"?' });
    expect(restore.textContent).toContain("without signing in or being added again");
    expect(api.mock.calls.some(([action]) => action.operation === "restore-workspace")).toBe(false);
    await act(async () => within(restore).getByRole("button", { name: "Restore" }).click());
    expect(screen.getByRole("cell", { name: "Active" })).toBeDefined();
    expect(screen.getByText("Project restored.")).toBeDefined();
    expect(api.mock.calls.filter(([action]) => action.operation === "restore-workspace").map(([action]) => action))
      .toEqual([{ operation: "restore-workspace", workspaceId: WORKSPACE }]);
  });

  it("drops hub authority and the inventory when a confirmed suspension is refused", async () => {
    api.mockImplementation(async (action) => {
      if (action.operation === "own-hub-role") return { status: "ok", role: "admin", hub: HUB };
      if (action.operation === "list-hub-workspaces") return { status: "ok", hub: HUB, workspaces: [INVENTORY], nextCursor: null };
      return { status: "forbidden", hub: HUB };
    });
    await renderSettled(<Reading page="hub-workspaces" />);
    await act(async () => screen.getByRole("button", { name: "Suspend Project" }).click());
    await act(async () => within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }).click());
    expect(screen.queryByRole("region", { name: "Hub" })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("hub refused access");
    expect(api.mock.calls.filter(([action]) => action.operation === "list-hub-workspaces")).toHaveLength(1);
  });

  it.each(["hub-admins", "hub-workspaces"] as const)("discards %s rows and authority when a subsequent page is refused", async (page) => {
    let finish: ((answer: AccessAnswer) => void) | undefined;
    api.mockImplementation(async (action) => {
      if (action.operation === "own-hub-role") return { status: "ok", role: "admin", hub: HUB };
      if (!("cursor" in action) || action.cursor === undefined) return { status: "ok", hub: HUB,
        admins: [ADMIN], workspaces: [INVENTORY], nextCursor: "next" };
      return new Promise((resolve) => { finish = resolve; });
    });
    await renderSettled(<Reading page={page} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("region", { name: "Hub" })).toBeDefined();
    await act(async () => finish?.({ status: "forbidden", hub: HUB }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("region", { name: "Hub" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("hub refused access");
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.queryByText("@person")).toBeNull();
  });

  it("stops a repeated cursor without publishing an incomplete list", async () => {
    api.mockImplementation(async (action) => action.operation === "own-hub-role"
      ? { status: "ok", role: "admin", hub: HUB }
      : { status: "ok", hub: HUB, admins: [ADMIN], nextCursor: "repeat" });
    await renderSettled(<Reading page="hub-admins" />);
    expect(api.mock.calls.filter(([action]) => action.operation === "list-hub-admins")).toHaveLength(2);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("cannot be reached");
  });
});
