import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupFigma } from "../src/editor/figma-lookup.js";

const LINK = "https://www.figma.com/design/key/Checkout-flow?node-id=12-345";

function ownerDocument(): Document {
  const owner = document.implementation.createHTMLDocument();
  Object.defineProperty(owner, "defaultView", { value: window });
  return owner;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Figma metadata lookup", () => {
  it("requests the normalized link without credentials, a referrer or redirects", async () => {
    const title = "<img src=x> **Checkout**";
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      title, html: "<iframe src='https://other.test'></iframe>", thumbnail_url: "https://other.test/image",
    }));
    await expect(lookupFigma(`${LINK.replace("www.figma.com", "figma.com")}&t=tracking&workspace=private#private`, ownerDocument()))
      .resolves.toEqual({ title });
    expect(fetch).toHaveBeenCalledOnce();
    const [target, options] = fetch.mock.calls[0]!;
    const address = new URL(String(target));
    expect(address.origin + address.pathname).toBe("https://www.figma.com/api/oembed");
    expect([...address.searchParams]).toEqual([["url", LINK]]);
    expect(options).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("shares an in-flight answer and retains it for the page's lifetime", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const owner = ownerDocument();
    const first = lookupFigma(LINK, owner);
    const second = lookupFigma(`${LINK.replace("www.figma.com", "figma.com")}&t=discarded`, owner);
    expect(fetch).toHaveBeenCalledOnce();
    finish(new Response("", { status: 404 }));
    await expect(first).resolves.toEqual({ private: true });
    await expect(second).resolves.toEqual({ private: true });
    await expect(lookupFigma(LINK, owner)).resolves.toEqual({ private: true });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps different links and different pages independent", async () => {
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ title: "First link" }))
      .mockResolvedValueOnce(Response.json({ title: "Second link" }))
      .mockResolvedValueOnce(Response.json({ title: "Other page" }));
    const firstPage = ownerDocument();
    await expect(lookupFigma(LINK, firstPage)).resolves.toEqual({ title: "First link" });
    await expect(lookupFigma(LINK.replace("/key/", "/second/"), firstPage)).resolves.toEqual({ title: "Second link" });
    await expect(lookupFigma(LINK, ownerDocument())).resolves.toEqual({ title: "Other page" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("falls back without claiming privacy on any other HTTP failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("untrusted answer", { status: 403 }));
    await expect(lookupFigma(LINK, ownerDocument())).resolves.toEqual({});
  });

  it.each([null, {}, { title: 12 }, { title: "" }, { title: "  " }])("falls back on an unreadable title %j", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(lookupFigma(LINK, ownerDocument())).resolves.toEqual({});
  });

  it("falls back on invalid JSON or a failed request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("not JSON"))
      .mockRejectedValueOnce(new TypeError("Fetch blocked"));
    const owner = ownerDocument();
    await expect(lookupFigma(LINK, owner)).resolves.toEqual({});
    await expect(lookupFigma(LINK.replace("/key/", "/blocked/"), owner)).resolves.toEqual({});
  });

  it("skips kinds that oEmbed does not reliably recognize as public", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(lookupFigma("https://www.figma.com/community/file/123456/Public-file", ownerDocument())).resolves.toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gives up and aborts when the endpoint never answers", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise<Response>(() => {}));
    const owner = ownerDocument();
    const answer = lookupFigma(LINK, owner);
    const signal = fetch.mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(answer).resolves.toEqual({});
    expect(signal.aborted).toBe(true);
    await expect(lookupFigma(LINK, owner)).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the deadline while reading the body and ignores a late title", async () => {
    vi.useFakeTimers();
    let finish!: (body: unknown) => void;
    const response = Response.json({});
    vi.spyOn(response, "json").mockReturnValue(new Promise<unknown>((resolve) => { finish = resolve; }));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const owner = ownerDocument();
    const answer = lookupFigma(LINK, owner);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(answer).resolves.toEqual({});
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    finish({ title: "Too late" });
    await expect(lookupFigma(LINK, owner)).resolves.toEqual({});
  });
});
