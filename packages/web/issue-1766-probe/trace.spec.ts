import { expect, test } from "@playwright/test";

for (const fails of [false, true]) {
  test(fails ? "@webkit failure keeps explicit contexts" : "@webkit pass discards explicit contexts", async ({ browser }) => {
    const contexts = [];
    try {
      for (const marker of ["explicit-context-one", "explicit-context-two"]) {
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        await page.setContent(`<h1>${marker}</h1>`);
        await expect(page.getByRole("heading")).toHaveText(marker);
      }
      expect(fails, "intentional failure for trace retention").toBe(false);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}
