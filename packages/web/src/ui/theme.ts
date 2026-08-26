/**
 * Appearance: which half of the token set the page paints with (#74).
 *
 * The whole mechanism is one attribute. `styles.css` names both values of every
 * colour in a single `light-dark()`, and `color-scheme` is what picks between
 * them — so setting `data-theme` on <html> re-themes the editor, the sidebar
 * and the vendored chrome at once, with no rule anywhere knowing a theme
 * exists. Removing the attribute hands the decision back to the system.
 *
 * The stored value is applied once before React mounts (see main.tsx) rather
 * than from an effect alone: an effect paints the system's answer first, and a
 * reader who chose dark would watch the app flash light on every reload.
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
 * The appearance in force, and the way to change it.
 *
 * The setting is the state — `useSetting` re-renders every reader when it is
 * written, and the effect below is what puts the choice on the document. So a
 * second tab that has not been told anything still starts from what was stored,
 * and this tab needs no local copy to keep honest.
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
