/**
 * The user card at the foot of the sidebar, and the panel it opens (#74,
 * design 1c).
 *
 * There are no accounts, so there is nothing here to sign into or out of. What
 * the panel holds is everything this client *is*: the name it publishes in
 * awareness, the colour peers see it in, which token set it paints with, how
 * much this browser is holding, and how many agent sessions are in the
 * workspace. All of it was already real client-held state — only the
 * affordances were missing.
 *
 * The trigger is an identity card (#482): a tile in this session's presence
 * colour carrying the first character of the name it publishes, then the name.
 * There is still no role, account or e-mail line under it — there are no
 * accounts, so a second line would have nothing true to say.
 *
 * A popover rather than a menu, deliberately. A menu is a list of commands you
 * pick one of and leave; this is a small panel of controls and readouts you
 * come back out of unchanged, and two of its rows are facts rather than
 * actions. The workspace switcher above it *is* a list of commands, and is a
 * menu (see `WorkspaceSwitcher`). Both surfaces are vendored shadcn (#27); how
 * they look is plain CSS on `.ub-*` classes, like every other product surface.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { AWARENESS_COLORS } from "../collab/identity.js";
import type { AwarenessUser } from "../collab/identity.js";
import { setSetting } from "../settings.js";
import type { Appearance } from "../settings.js";
import { useSetting } from "./hooks.js";
import { initialOf } from "./PeerAvatar.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./shadcn/popover.js";
import { APPEARANCES, useAppearance } from "./theme.js";

/** What each appearance is called. */
const APPEARANCE_LABELS: Record<Appearance, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * How much this browser is holding, in the units `storage.estimate()` reports
 * it in — decimal, like the browser's own storage panel.
 *
 * Exported for the General settings page (#485), which says the same fact in the
 * same words: two spellings of one number is how "12.4 MB" and "12 MB" end up on
 * screen at once claiming to be the same reading.
 */
export function formatBytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${Math.round(bytes / 1_000)} kB`;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/**
 * What this origin is using, or null where the browser will not say.
 *
 * Re-read whenever the panel opens, because it is a number that moves: every
 * document this tab reads lands in the IndexedDB replica. Null covers both ways
 * of not knowing — no Storage API at all, or an estimate that rejected — and
 * the row is left out rather than showing a zero nobody can vouch for.
 *
 * Closing forgets it, which matters for the same reason the re-read does: a
 * kept number is a stale number, and the next open would paint the last
 * session's figure for as long as the fresh estimate takes to answer.
 *
 * `open` is "is this surface on screen": a panel's open state here, and simply
 * `true` on the General settings page (#485), which is on screen for as long as
 * it is mounted. Exported so that page reads the estimate through the same
 * three-valued answer — a row omitted rather than a zero nobody can vouch for.
 */
export function useLocalCacheSize(open: boolean): number | null {
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    if (!open) {
      setBytes(null);
      return;
    }
    if (typeof navigator.storage?.estimate !== "function") return;
    let live = true;
    void navigator.storage.estimate().then(
      (report) => {
        if (live && typeof report.usage === "number") setBytes(report.usage);
      },
      () => {
        // A browser that declines to answer has told us nothing worth showing.
      },
    );
    return () => {
      live = false;
    };
  }, [open]);
  return bytes;
}

export function UserMenu({
  identity,
  agentSessions,
}: {
  /**
   * This tab's awareness identity: the name it publishes, and the colour it was
   * given before anybody chose one.
   */
  identity: AwarenessUser;
  /**
   * MCP sessions in the workspace right now — `useAgentSessions` is where
   * "which of these is an agent" is decided.
   */
  agentSessions: number;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const color = useSetting("presenceColor") ?? identity.color;
  const [appearance, chooseAppearance] = useAppearance();
  const cache = useLocalCacheSize(open);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="ub-user-card" aria-label="You">
          <span
            className="ub-identity-tile ub-user-tile"
            style={{ background: color }}
            aria-hidden="true"
          >
            {initialOf(identity.name)}
          </span>
          <span className="ub-user-name">{identity.name}</span>
          <span className="ub-menu-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="ub-user-panel">
        <p className="ub-user-heading">{identity.name}</p>

        {/* A caption over a set of related controls is what a fieldset is. */}
        <fieldset className="ub-panel-group">
          <legend className="ub-panel-label">Presence colour</legend>
          <div className="ub-swatches">
            {AWARENESS_COLORS.map((swatch) => (
              <button
                key={swatch.hex}
                type="button"
                className="ub-swatch"
                style={{ background: swatch.hex }}
                // The palette is unnamed hues; the name is what makes a swatch
                // choosable without seeing it.
                aria-label={swatch.name}
                aria-pressed={swatch.hex === color}
                onClick={() => setSetting("presenceColor", swatch.hex)}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className="ub-panel-group">
          <legend className="ub-panel-label">Appearance</legend>
          <div className="ub-appearance">
            {APPEARANCES.map((option) => (
              <button
                key={option}
                type="button"
                className="ub-appearance-option"
                aria-pressed={option === appearance}
                onClick={() => chooseAppearance(option)}
              >
                {APPEARANCE_LABELS[option]}
              </button>
            ))}
          </div>
        </fieldset>

        {/* Facts, not actions — see the header. */}
        <dl className="ub-panel-facts">
          {cache !== null && (
            <div className="ub-panel-fact">
              <dt>Local cache</dt>
              <dd>{formatBytes(cache)}</dd>
            </div>
          )}
          <div className="ub-panel-fact">
            <dt>MCP connections</dt>
            <dd>{agentSessions}</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  );
}
