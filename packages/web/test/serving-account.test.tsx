import { act, render } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountClient, AccountIdentity } from "../src/shell/account.js";
import { useServingAccount } from "../src/ui/status/serving-account.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "../src/ui/status/serving-status.js";
import { screen } from "@testing-library/react";
import * as Y from "yjs";
import { appendBlock, createAnnotation, getAnnotation, getMeta, initDoc, listAnnotations, parseRoom } from "@uberblick/schema";
import type { Editor } from "@tiptap/core";
import type { RoomConnection } from "../src/collab/rooms.js";
import { ShellThreads } from "../src/ui/shell/ShellThreads.js";
import { ShellDocument } from "../src/ui/shell/ShellDocument.js";
import type { AppShell } from "../src/ui/shell/use-app-shell.js";
import { useThreads } from "../src/ui/hooks.js";

const NOOP = () => {};

function Reading({ api }: { api: AccountClient | null }) {
  const account = useServingAccount(api);
  return <output>{account.state === "signed-in" ? account.handle : account.state}</output>;
}
function mount(api: AccountClient | null) {
  const view = render(<Reading api={api} />);
  return { host: view.container, view };
}
async function flush() {
  await act(async () => { await Promise.resolve(); });
}

function CommentReading({ api, connection }: { api: AccountClient | null; connection: RoomConnection }) {
  const account = useServingAccount(api);
  const threads = useThreads(connection);
  const room = parseRoom(connection.room);
  const shell = {
    rooms: { doc: connection, docStatus: connection.status, topic: null, catalog: null, directory: null, deleted: false,
      selected: room.uuid, topicTitleRoom: null, sidebarStatus: { writable: false }, directoryStatus: { writable: false } },
    readings: { archived: false, meta: getMeta(connection.ydoc), relatedTopics: [], titlePresence: [], servingStatus: null, selectedDirectoryEntry: null, chromeRoom: connection },
    environment: { identity: { name: "Presence name" }, account, route: { kind: "doc", workspace: { uuid: room.workspaceId, segment: room.workspaceId }, uuid: room.uuid },
      hubReady: true, statusEndpoint: null, serving: null },
    layout: { narrowLayout: false },
    threads: { threads, focusedThread: null, threadsOpen: false, onFocusThread: NOOP, setThreadsOpen: NOOP, restoreThreadsFocus: NOOP },
    navigation: { docLinks: null }, history: { active: false, available: false }, historyBack: { current: null },
    sync: { syncOpen: false, setSyncOpen: NOOP }, pins: { pinned: false },
    alter: {}, archive: { restoreFocusRoom: { current: null }, archiveConfirmationFocusRoom: { current: null } },
  } as unknown as AppShell;
  // useRoom returns null between workspace rooms, unmounting the old editor.
  return <><ShellDocument key={connection.room} shell={shell} /><ShellThreads shell={shell} /></>;
}

function commentDoc(workspace: string) {
  const ydoc = new Y.Doc();
  const uuid = crypto.randomUUID();
  initDoc(ydoc, { uuid, title: "Comments" });
  const block = appendBlock(ydoc, { type: "paragraph", text: "Prose" });
  const thread = createAnnotation(ydoc, block, 0, 5, "Legacy author", "Question");
  appendBlock(ydoc, { type: "paragraph", text: "More prose" });
  const status = { writable: true, hasAnswered: true, connected: false, synced: false,
    hasReceivedServerState: true, storeRefused: false, unsyncedChanges: 0,
    protocolMismatch: null, authFailed: false, tokenMissing: false };
  const connection = { room: `${workspace}/${uuid}`, ydoc, status, provider: { awareness: null },
    onStatusChange: (listener: (value: typeof status) => void) => { listener(status); return () => {}; },
  } as unknown as RoomConnection;
  return { ydoc, thread, connection };
}

async function reply() {
  await act(async () => { screen.getAllByRole<HTMLButtonElement>("button", { name: "Reply" })[0]!.click(); });
  const field = screen.getByPlaceholderText<HTMLTextAreaElement>("Reply…");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "Reply");
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "Reply", inputType: "insertText" }));
  });
  await act(async () => { screen.getAllByRole<HTMLButtonElement>("button", { name: "Reply" })[0]!.click(); });
}

async function opener() {
  const element = screen.getByRole("textbox", { name: "Document content" }) as HTMLElement & { editor: Editor };
  const editor = element.editor;
  editor.view.setProps({ handleScrollToSelection: () => true });
  act(() => { editor.commands.setTextSelection({ from: editor.state.doc.child(0).nodeSize + 1, to: editor.state.doc.child(0).nodeSize + 3 }); });
  await act(async () => { screen.getByText("Comment", { selector: "button" }).click(); });
  const field = screen.getByPlaceholderText<HTMLTextAreaElement>(/^Comment as /);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, "New question");
    field.dispatchEvent(new InputEvent("input", { bubbles: true, data: "New question", inputType: "insertText" }));
  });
  await act(async () => { screen.getByText("Comment", { selector: "button" }).click(); });
}

describe("the current served account", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attributes shell openers and replies to the shown workspace and clears stale account data during a switch", async () => {
    const first = commentDoc("722007fa-8921-45ee-a580-e20311030fef");
    const second = commentDoc("6f4c8a51-2b7d-4e39-9a06-c81d3f572be4");
    const direct = commentDoc("b2d9e4c7-5a13-4f80-8e6b-71c0a9d35f2e");
    const firstAccount = { state: "signed-in", handle: "first-person", principalId: "5df99824-b9b5-4260-b20c-4680e2d51fac" } as const;
    const secondAccount = { state: "signed-in", handle: "second-person", principalId: "b5154792-7d2f-4cb1-bd8a-bef5a859bf20" } as const;
    const firstApi: AccountClient = async () => firstAccount;
    let finish!: (account: AccountIdentity) => void;
    const secondApi: AccountClient = () => new Promise(resolve => { finish = resolve; });
    const view = render(<CommentReading api={firstApi} connection={first.connection} />);
    await flush();
    await opener();
    expect(listAnnotations(first.ydoc).flatMap(thread => thread.comments).find(comment => comment.text === "New question")).toMatchObject({
      author: "Presence name", kind: "person", account: firstAccount.handle, principalId: firstAccount.principalId,
    });
    await reply();
    expect(getAnnotation(first.ydoc, first.thread.id)?.comments[1]).toMatchObject({
      author: "Presence name", kind: "person", account: firstAccount.handle, principalId: firstAccount.principalId,
    });

    view.rerender(<CommentReading api={secondApi} connection={second.connection} />);
    await flush();
    await reply();
    expect(getAnnotation(second.ydoc, second.thread.id)?.comments[1]).toEqual({
      author: "Presence name", text: "Reply", createdAt: expect.any(String), kind: "person",
    });
    await act(async () => finish(secondAccount));
    await reply();
    expect(getAnnotation(second.ydoc, second.thread.id)?.comments[2]).toMatchObject({
      author: "Presence name", kind: "person", account: secondAccount.handle, principalId: secondAccount.principalId,
    });

    view.rerender(<CommentReading api={null} connection={direct.connection} />);
    await flush();
    await reply();
    expect(getAnnotation(direct.ydoc, direct.thread.id)?.comments[1]).toEqual({
      author: "Presence name", text: "Reply", createdAt: expect.any(String), kind: "person",
    });
    view.unmount();
    first.ydoc.destroy(); second.ydoc.destroy(); direct.ydoc.destroy();
  });

  it("refreshes login/logout and blanks a previous handle on failure", async () => {
    vi.useFakeTimers();
    let answer: AccountIdentity | Error = { state: "signed-in", handle: "octocat" };
    const api: AccountClient = async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const { host, view } = mount(api);
    await flush();
    expect(host.textContent).toBe("octocat");
    answer = { state: "signed-out" };
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("signed-out");
    answer = { state: "signed-in", handle: "another-person" };
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("another-person");
    answer = new Error("request failed");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("unavailable");
    view.rerender(<Reading api={null} />);
    expect(host.textContent).toBe("unavailable");
  });

  it("ignores late answers from another serving client", async () => {
    let finish!: (account: AccountIdentity) => void;
    const api: AccountClient = () => new Promise(resolve => { finish = resolve; });
    const { host, view } = mount(api);
    view.rerender(<Reading api={async () => ({ state: "signed-out" })} />);
    await flush();
    await act(async () => finish({ state: "signed-in", handle: "wrong-hub" }));
    expect(host.textContent).toBe("signed-out");
  });

  it("expires hung requests, aborts on unmount and resumes polling", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const api: AccountClient = async (signal) => {
      signals.push(signal);
      calls += 1;
      if (calls === 2 || calls === 4) return await new Promise(() => {});
      return { state: "signed-in", handle: "octocat" };
    };
    const { host, view } = mount(api);
    await flush();
    expect(host.textContent).toBe("octocat");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS + SERVING_STATUS_TIMEOUT_MS));
    expect(signals[1]?.aborted).toBe(true);
    expect(host.textContent).toBe("unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    expect(host.textContent).toBe("octocat");
    await act(async () => vi.advanceTimersByTimeAsync(SERVING_STATUS_POLL_MS));
    view.unmount();
    expect(signals[3]?.aborted).toBe(true);
  });
});
