import { act, render } from "./react-render.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountClient, AccountIdentity } from "../src/shell/account.js";
import { useServingAccount } from "../src/ui/serving-account.js";
import { SERVING_STATUS_POLL_MS, SERVING_STATUS_TIMEOUT_MS } from "../src/ui/serving-status.js";

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

describe("the current served account", () => {
  afterEach(() => {
    vi.useRealTimers();
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
