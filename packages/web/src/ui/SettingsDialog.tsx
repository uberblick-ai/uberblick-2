/**
 * Settings (#176): the machine-local half of configuration, in one dialog.
 *
 * A dialog rather than a route, because settings are a detour and not a place:
 * the reader opens them from the sidebar's gear, changes one thing, and is back
 * where they were with the address bar untouched.
 *
 * Everything it reads and writes goes through `settings.ts`, which is the only
 * module allowed to touch localStorage for settings — nothing here knows the
 * key, and nothing here can reach a Y.Doc. A pasted token therefore has no path
 * into a document, an export, or the hub.
 *
 * One section exists so far, Connections. The layout is a list of sections of
 * entries so the next one (models, when the ablauf work arrives) is a sibling
 * rather than a rewrite — and no more than that is built here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { setSetting } from "../settings.js";
import { useSetting } from "./hooks.js";

/** What GitHub is asked for a token's identity. Nothing else is requested. */
const GITHUB_USER_URL = "https://api.github.com/user";

/** The scopes the copy asks for, spelled the way GitHub's own UI spells them. */
const GITHUB_SCOPES = "Issues: read, Pull requests: read, Metadata: read";

/** Anything a reader can tab to. Used by the focus trap and nothing else. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

type TokenCheck =
  | { ok: true; login: string }
  | { ok: false; error: string };

/**
 * Ask GitHub who a token belongs to — the one call that validates a paste.
 *
 * Every non-2xx answer is a refusal to store anything. 401 is the one worth
 * naming, because it is the one the reader can act on: the token is wrong,
 * expired, or was pasted with a character missing.
 */
async function checkGithubToken(token: string): Promise<TokenCheck> {
  let response: Response;
  try {
    response = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
  } catch {
    // Offline, or github.com unreachable. Not the token's fault, and saying so
    // keeps the reader from re-pasting a token that was fine.
    return { ok: false, error: "Could not reach github.com. Nothing was saved." };
  }
  if (response.status === 401) {
    return { ok: false, error: "GitHub rejected that token (401). Nothing was saved." };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: `GitHub answered ${response.status}. Nothing was saved.`,
    };
  }
  const body: unknown = await response.json().catch(() => null);
  const login =
    typeof body === "object" && body !== null
      ? (body as { login?: unknown }).login
      : null;
  if (typeof login !== "string" || login === "") {
    return { ok: false, error: "GitHub answered without a login. Nothing was saved." };
  }
  return { ok: true, login };
}

/**
 * The GitHub connection: connected as somebody, or a field to paste a token in.
 *
 * The two states are one entry rather than two components because they are one
 * fact — whether this browser holds a token — read straight from the store, so
 * a disconnect anywhere is reflected here without a second copy to update.
 */
function GithubConnection(): ReactElement {
  const token = useSetting("githubToken");
  const login = useSetting("githubLogin");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const connect = useCallback(async (): Promise<void> => {
    const pasted = draft.trim();
    if (pasted === "" || checking) return;
    setChecking(true);
    setError(null);
    const result = await checkGithubToken(pasted);
    setChecking(false);
    if (!result.ok) {
      // Nothing is written: a token GitHub would not answer for is not a token
      // worth keeping, and storing it would leave every later reader to
      // rediscover that it is broken.
      setError(result.error);
      return;
    }
    setSetting("githubToken", pasted);
    setSetting("githubLogin", result.login);
    setDraft("");
  }, [checking, draft]);

  const disconnect = useCallback((): void => {
    setSetting("githubToken", null);
    setSetting("githubLogin", null);
    setError(null);
  }, []);

  return (
    <div className="ub-setting">
      <div className="ub-setting-head">
        <h4 className="ub-setting-title">GitHub</h4>
        {token !== null && (
          <span className="ub-setting-state">connected as {login ?? "—"}</span>
        )}
      </div>
      <p className="ub-setting-copy">
        Reference hovercards (#175) read the title and state of issues and pull
        requests you link to. Paste a fine-grained personal access token with
        read-only access: <strong>{GITHUB_SCOPES}</strong>.
      </p>
      <p className="ub-setting-copy ub-muted">
        The token is kept in this browser only. It is never written to a
        document, never exported, and never sent anywhere but github.com.
      </p>
      {token === null ? (
        <div className="ub-setting-row">
          <input
            className="ub-setting-input"
            type="password"
            aria-label="GitHub token"
            placeholder="github_pat_…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            className="ub-tool ub-tool-on"
            disabled={draft.trim() === "" || checking}
            onClick={() => void connect()}
          >
            {checking ? "Checking…" : "Connect"}
          </button>
        </div>
      ) : (
        <div className="ub-setting-row">
          <button type="button" className="ub-tool" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}
      {error !== null && (
        <p className="ub-setting-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The dialog. Rendered only while open — an overlay nobody asked for should not
 * be in the tree at all.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const dialog = useRef<HTMLDivElement | null>(null);

  /**
   * Escape closes settings, and settings alone.
   *
   * Capture phase on `window`, then consumed — the same rule the sync panel
   * follows (#183): the topmost open layer takes the key, so one press
   * dismisses one thing rather than everything that happens to be listening. An
   * Escape somebody inside already handled is left alone.
   */
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);

  /**
   * Focus moves in on open and back out on close. A modal that leaves focus
   * behind it puts the reader's next keystroke somewhere they cannot see, and
   * closing without handing focus back would drop them at the top of the page.
   */
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = dialog.current;
    if (panel !== null) (focusable(panel)[0] ?? panel).focus();
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  /**
   * Tab wraps inside the dialog: while it is open there is nowhere else.
   *
   * On `window`, in the capture phase, rather than on the dialog element — a
   * handler that only fires for keys pressed *inside* the dialog is no trap at
   * all, because it never runs for the case that needs it. The shell is
   * `inert` while this is open, so focus should not be out there; if it is
   * anyway (a browser that ignores `inert`, a click that landed before the
   * attribute did), the next Tab brings it back rather than walking away.
   */
  useEffect(() => {
    const trap = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return;
      const panel = dialog.current;
      if (panel === null) return;
      const items = focusable(panel);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !panel.contains(active);
      const leaving = outside || (event.shiftKey ? active === first : active === last);
      if (!leaving) return;
      event.preventDefault();
      (!outside && event.shiftKey ? last : first).focus();
    };
    window.addEventListener("keydown", trap, true);
    return () => window.removeEventListener("keydown", trap, true);
  }, []);

  return (
    /* The scrim dims what is behind and catches stray clicks. It is not itself
       a way out: Escape and the close control are, and both are reachable from
       the keyboard — a click target that only a mouse can find would be a third
       exit that half the readers never see. */
    <div className="ub-modal">
      <div
        ref={dialog}
        className="ub-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ub-settings-title"
      >
        <div className="ub-settings-head">
          <h2 id="ub-settings-title" className="ub-rail-head">
            Settings
          </h2>
          <button
            type="button"
            className="ub-tool"
            aria-label="Close settings"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="ub-muted ub-settings-scope">
          This machine and this browser. Nothing here is synced or shared with
          the workspace.
        </p>
        <section className="ub-settings-section" aria-labelledby="ub-settings-conn">
          <h3 id="ub-settings-conn" className="ub-settings-section-title">
            Connections
          </h3>
          <GithubConnection />
        </section>
      </div>
    </div>
  );
}
