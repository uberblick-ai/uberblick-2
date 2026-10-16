import { FIGMA_PROVIDER } from "@uberblick/schema";

export interface FigmaLookup { title?: string; private?: boolean }

const lookups = new WeakMap<Document, Map<string, Promise<FigmaLookup>>>();

/** Display metadata belongs to this page, never to the shared document. */
export function lookupFigma(storedLink: string, owner: Document): Promise<FigmaLookup> {
  const address = FIGMA_PROVIDER.lookupAddress(storedLink);
  if (address === null) return Promise.resolve({});
  let cache = lookups.get(owner);
  if (cache === undefined) { cache = new Map(); lookups.set(owner, cache); }
  const cached = cache.get(address);
  if (cached !== undefined) return cached;
  const pending = request(address, owner);
  cache.set(address, pending);
  return pending;
}

async function request(address: string, owner: Document): Promise<FigmaLookup> {
  const browser = owner.defaultView;
  if (browser === null) return {};
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<FigmaLookup>((resolve) => {
    timer = setTimeout(() => { resolve({}); controller.abort(); }, 5000);
  });
  try {
    return await Promise.race([timeout, (async (): Promise<FigmaLookup> => {
      const response = await browser.fetch(address, {
        credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal,
      });
      if (response.status === 404) return { private: true };
      if (response.status !== 200) return {};
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("title" in body) ||
        typeof body.title !== "string" || body.title.trim() === "") return {};
      return { title: body.title };
    })()]);
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
