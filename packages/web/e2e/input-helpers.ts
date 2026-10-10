/** Native fixture input follows the page's device, with interior cell targets. */
import type { Locator } from "@playwright/test";

export async function activateControl(target: Locator, options: { touch?: boolean | undefined } = {}): Promise<void> {
  const touch = options.touch ?? await target.evaluate(() => navigator.maxTouchPoints > 0);
  if (touch) {
    // The documented 44px border controls can cover a cell's edge or centre.
    // Fixture caret input belongs inside the cell, away from those controls.
    const position = await target.evaluate(element => element.matches("th, td")
      ? { x: element.getBoundingClientRect().width / 4, y: element.getBoundingClientRect().height / 2 }
      : undefined);
    await target.tap(position === undefined ? {} : { position });
  } else await target.click();
}
