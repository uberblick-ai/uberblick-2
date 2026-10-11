/**
 * Only explicit light/dark values stamp data-theme; removing it restores
 * system color-scheme. The blocking index.html bootstrap and this module use
 * the same stored key so first paint and later renders agree. Reassert at
 * startup if the bootstrap did not run.
 */

import { useCallback, useEffect } from "react";
import { getSetting, setSetting } from "../settings.js";
import type { Appearance } from "../settings.js";
import { useSetting } from "./hooks.js";

/** What the menu offers, in the order it offers it. */
export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

/** Paint with `appearance`. "system" removes the choice rather than guessing. */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;
  if (appearance === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", appearance);
}

/** Apply what this browser stored. Called before the first render. */
export function applyStoredAppearance(): void {
  applyAppearance(getSetting("appearance") ?? "system");
}

/**
 * Read appearance from the shared local setting; its subscription updates
 * consumers and this effect applies the document attribute.
 */
export function useAppearance(): [Appearance, (next: Appearance) => void] {
  const appearance = useSetting("appearance") ?? "system";
  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);
  const choose = useCallback((next: Appearance) => {
    setSetting("appearance", next);
  }, []);
  return [appearance, choose];
}
