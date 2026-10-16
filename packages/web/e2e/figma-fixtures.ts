import type { Page, Route } from "@playwright/test";

export const FIGMA_LOOKUP = "https://www.figma.com/api/oembed**";

export async function answerFigmaLookup(route: Route, title = "Figma fixture title"): Promise<void> {
  await route.fulfill({ json: { title }, headers: { "access-control-allow-origin": "*" } });
}

/** Synthetic viewers must never send the new lookup to the real provider. */
export async function mockFigmaLookup(page: Page): Promise<void> {
  await page.route(FIGMA_LOOKUP, (route) => answerFigmaLookup(route));
}
