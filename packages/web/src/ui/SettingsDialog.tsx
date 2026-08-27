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
 * Two sections exist so far, Connections and Storage. The layout is a list of
 * sections of entries so the next one (models, when the ablauf work arrives) is
 * a sibling rather than a rewrite — and no more than that is built here.
 *
 * Storage is the one exception to "nothing here can reach a Y.Doc", and only in
 * one direction: it reads and deletes the *IndexedDB replicas* rooms leave
 * behind (`collab/forget.ts`). It never opens a room, never writes one, and
 * never talks to the hub.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { setSetting } from "../settings.js";
import {
  cachedWorkspaces,
  canListDatabases,
  forgetWorkspace,
  originUsage,
} from "../collab/forget.js";
import type { ForgetResult, WorkspaceCache } from "../collab/forget.js";
import { useSetting } from "./hooks.js";
import type { Workspace } from "./route.js";

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

/** The word the reader has to type. Short, unambiguous, and not a click. */
const CONFIRM_WORD = "forget";

/**
 * "no documents", "1 document", "4 documents" — a count in a sentence should
 * read as English, and zero is a real answer here: a workspace that has only
 * ever been opened still caches its directory and sidebar.
 */
function docCount(documents: number): string {
  if (documents === 0) return "no documents";
  return documents === 1 ? "1 document" : `${documents} documents`;
}

/** Bytes, rounded to something a person reads rather than parses. */
function bytesLabel(bytes: number): string {
  const mb = bytes / 1_000_000;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

/**
 * What forgetting this workspace would throw away — the sentence the reader has
 * to have read before the confirmation can be accepted (#198).
 *
 * Three answers, and the third is the point. "Unknown" is not a softer way of
 * saying "none": a cached room with no live connection carries no readable
 * backlog, and nothing persists an acknowledged watermark, so the browser
 * genuinely cannot tell without asking the hub — which it will not do, because
 * the cache exists for the times the hub is not there.
 *
 * "Of them" is every cached room, not only the documents: an un-synced pin or
 * sidebar group is lost as finally as an un-synced paragraph, and a cost
 * sentence that counted fewer things than the forget removes would under-state
 * the one number it exists to state.
 */
function unsyncedSentence(cache: WorkspaceCache): string {
  if (cache.unsynced > 0) {
    const holds = cache.unsynced === 1 ? "holds" : "hold";
    const rest = cache.certain
      ? ""
      : " For the rest, this browser cannot tell without asking the hub.";
    return (
      `${cache.unsynced} of them ${holds} updates the hub has not acknowledged. ` +
      `Forgetting throws those edits away, and nothing recovers them.${rest}`
    );
  }
  if (cache.certain) {
    return "The hub has acknowledged every update in this browser's copy.";
  }
  return (
    "Un-synced edits: unknown. This browser cannot tell whether any of them " +
    "hold updates the hub has not acknowledged without asking the hub, and it " +
    "does not ask. If any do, forgetting throws them away and nothing recovers " +
    "them."
  );
}

/**
 * What a finished forget did, in the reader's terms.
 *
 * Driven by the per-database outcomes the deletion requests themselves
 * reported, never by what the browser lists afterwards. A database whose
 * deletion is *queued* — another tab still has it open — may already be gone
 * from `databases()`, so a note written from the listing would tell the reader
 * it was removed when the browser has not removed it yet. The listing only adds
 * the last sentence: whether any of this could be re-checked at all.
 *
 * Three outcomes, and only one of them is "gone". Queued is not refused, so it
 * must not read as a failure the reader has to act on; refused is not queued,
 * so it must not read as a promise that it will finish on its own.
 */
function forgetNote(workspaceId: string, result: ForgetResult): string {
  const asked = `${result.attempted} cached ${
    result.attempted === 1 ? "database" : "databases"
  }`;
  const clean =
    result.removed === result.attempted &&
    result.scheduled === 0 &&
    result.failed === 0;
  const parts = [
    `Forgot ${workspaceId}: ${
      clean ? `all ${asked}` : `${result.removed} of ${asked}`
    } removed from this browser.`,
  ];
  if (result.scheduled > 0) {
    const one = result.scheduled === 1;
    parts.push(
      `${result.scheduled} ${one ? "is" : "are"} still open in another tab — ` +
        `${one ? "its" : "their"} removal is scheduled and completes when that ` +
        `tab is closed.`,
    );
  }
  if (result.failed > 0) {
    parts.push(
      `${result.failed} could not be removed: the browser refused the ` +
        `${result.failed === 1 ? "deletion" : "deletions"}.`,
    );
  }
  if (clean) {
    parts.push("Opening the workspace again re-downloads it from the hub.");
  }
  if (result.remaining === null) {
    parts.push(
      "This browser would not say what it still stores afterwards, so none of " +
        "that could be re-checked.",
    );
  }
  return parts.join(" ");
}

/** The read of what is stored: still running, refused, or an answer. */
type CacheState =
  | { kind: "reading" }
  | { kind: "unavailable" }
  | { kind: "ready"; caches: WorkspaceCache[] };

/**
 * Storage: what this browser keeps for each workspace it has visited, and the
 * way to forget one of them (#198).
 *
 * Deleting is allowed even when local edits never reached the hub — the owner's
 * call, and the reason the gate is a typed word rather than a button: the cost
 * is stated above the field, so accepting it is a thing the reader did, not a
 * thing that happened to them. The workspace on screen is excluded, because
 * forgetting what you are looking at would delete the replica the open editor
 * is writing into.
 */
function WorkspaceStorage({ workspace }: { workspace: Workspace | null }): ReactElement {
  // Seeded rather than defaulted: a browser that cannot list its own databases
  // is answered before the first paint, so nothing is read and nothing is
  // rendered as "still reading" that will never finish.
  const [state, setState] = useState<CacheState>(() =>
    canListDatabases() ? { kind: "reading" } : { kind: "unavailable" },
  );
  const [usage, setUsage] = useState<number | null>(null);
  /** The workspace whose confirmation is open — at most one at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  /** What the last forget actually did. Cleared when another one is opened. */
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const caches = await cachedWorkspaces();
    setState(caches === null ? { kind: "unavailable" } : { kind: "ready", caches });
  }, []);

  useEffect(() => {
    if (!canListDatabases()) return;
    void reload();
    void originUsage().then(setUsage);
  }, [reload]);

  /** The control that opened the confirmation, so cancelling can return focus. */
  const trigger = useRef<HTMLButtonElement | null>(null);

  const open = useCallback((workspaceId: string, from: HTMLButtonElement): void => {
    trigger.current = from;
    setConfirming(workspaceId);
    setTyped("");
    setNote(null);
  }, []);

  /** Set by `cancel`; consumed by the effect below once the form is gone. */
  const returnFocus = useRef(false);

  const cancel = useCallback((): void => {
    // The confirmation is unmounting with focus inside it, so focus has to be
    // handed back — and only *after* the re-render, because the trigger is
    // disabled while its confirmation is open and a disabled control cannot
    // take focus.
    returnFocus.current = true;
    setConfirming(null);
    setTyped("");
  }, []);

  /** The confirmation's field, while one is open. */
  const field = useRef<HTMLInputElement | null>(null);

  /**
   * Focus follows the confirmation: into the field when one opens, and back to
   * the control that opened it when one is dismissed. A gate the keyboard
   * cannot reach is not a gate, and a form that unmounts with focus inside it
   * drops the reader on the document body.
   */
  useEffect(() => {
    if (confirming !== null) {
      field.current?.focus();
      return;
    }
    if (!returnFocus.current) return;
    returnFocus.current = false;
    if (trigger.current?.isConnected === true) trigger.current.focus();
  }, [confirming]);

  /** The sentence a finished forget leaves behind, and where focus goes. */
  const status = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (note !== null) status.current?.focus();
  }, [note]);

  const forget = useCallback(
    async (cache: WorkspaceCache): Promise<void> => {
      if (busy) return;
      setBusy(true);
      const result = await forgetWorkspace(cache.workspaceId);
      setBusy(false);
      setConfirming(null);
      setTyped("");
      setNote(forgetNote(cache.workspaceId, result));
      await reload();
    },
    [busy, reload],
  );

  return (
    <div className="ub-setting">
      <div className="ub-setting-head">
        <h4 className="ub-setting-title">Cached workspaces</h4>
      </div>
      <p className="ub-setting-copy">
        Every workspace you open leaves a full copy of its documents in this
        browser, so it keeps working with the hub away. Each count below is
        documents; a workspace also caches its directory and sidebar, and
        forgetting removes those too. Forgetting removes that copy from this
        device and nothing else — the workspace, the hub and every other machine
        are untouched, and opening it again re-downloads it.
      </p>
      {state.kind !== "unavailable" && (
        <p className="ub-setting-copy ub-muted">
          {usage === null
            ? "This browser does not report how much it stores for this site."
            : `This site stores about ${bytesLabel(usage)} in total. The browser ` +
              "reports no per-workspace breakdown, so that number covers every " +
              "workspace below at once."}
        </p>
      )}
      {state.kind === "reading" && (
        <p className="ub-setting-copy ub-muted">Reading what is stored…</p>
      )}
      {state.kind === "unavailable" && (
        <p className="ub-setting-copy ub-muted">
          This browser does not let a page list its own databases, so uberblick
          cannot tell what is stored here or forget one workspace at a time. Its
          own site-data controls clear everything for this site at once.
        </p>
      )}
      {state.kind === "ready" && state.caches.length === 0 && (
        <p className="ub-setting-copy ub-muted">
          Nothing is cached in this browser yet.
        </p>
      )}
      {state.kind === "ready" &&
        state.caches.map((cache) => {
          const here = cache.workspaceId === workspace?.uuid;
          const isConfirming = confirming === cache.workspaceId;
          return (
            <div key={cache.workspaceId} className="ub-forget">
              <div className="ub-forget-head">
                <code className="ub-forget-name">{cache.workspaceId}</code>
                <span className="ub-muted">{docCount(cache.documents)}</span>
              </div>
              {here ? (
                /* The open workspace is not forgettable: the editor is writing
                   into this very replica, so there is no control to press. */
                <p className="ub-setting-copy ub-muted">
                  Open now — switch to another workspace to forget this one.
                </p>
              ) : (
                <>
                  {/* The trigger stays mounted while its confirmation is open,
                      so cancelling has somewhere to hand focus back to. */}
                  <div className="ub-setting-row">
                    <button
                      type="button"
                      className="ub-tool"
                      disabled={isConfirming}
                      onClick={(event) => open(cache.workspaceId, event.currentTarget)}
                    >
                      Forget on this device…
                    </button>
                  </div>
                  {isConfirming && (
                    <form
                      className="ub-forget-confirm"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (typed.trim().toLowerCase() !== CONFIRM_WORD) return;
                        void forget(cache);
                      }}
                    >
                      {/* Described by, not announced at: the cost is static
                          text that was on screen before the field existed, so
                          `role="alert"` would interrupt a reader for something
                          nothing changed. `aria-describedby` reads it out when
                          focus reaches the field it gates — which is the moment
                          it matters. */}
                      <p
                        id={`ub-forget-cost-${cache.workspaceId}`}
                        className="ub-setting-copy ub-forget-cost"
                      >
                        {unsyncedSentence(cache)}
                      </p>
                      <p
                        id={`ub-forget-queued-${cache.workspaceId}`}
                        className="ub-setting-copy ub-muted"
                      >
                        A cache another tab still has open is not removed
                        straight away: its deletion is scheduled, and the browser
                        completes it when that tab closes.
                      </p>
                      <label
                        className="ub-setting-copy"
                        htmlFor={`ub-forget-${cache.workspaceId}`}
                      >
                        Type <strong>{CONFIRM_WORD}</strong> to remove this
                        browser&rsquo;s copy of {docCount(cache.documents)}.
                      </label>
                      <div className="ub-setting-row">
                        <input
                          id={`ub-forget-${cache.workspaceId}`}
                          className="ub-setting-input"
                          type="text"
                          autoComplete="off"
                          aria-describedby={
                            `ub-forget-cost-${cache.workspaceId} ` +
                            `ub-forget-queued-${cache.workspaceId}`
                          }
                          ref={field}
                          value={typed}
                          onChange={(event) => setTyped(event.target.value)}
                        />
                        <button
                          type="submit"
                          className="ub-tool ub-tool-danger"
                          disabled={typed.trim().toLowerCase() !== CONFIRM_WORD || busy}
                        >
                          {busy ? "Forgetting…" : "Forget this workspace"}
                        </button>
                        <button
                          type="button"
                          className="ub-tool"
                          disabled={busy}
                          onClick={cancel}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </div>
          );
        })}
      {note !== null && (
        /* Focusable only programmatically: a completed forget removes the card
           the reader was standing on, so focus lands here — on the sentence
           that says what happened — rather than on the document body. */
        <p
          ref={status}
          tabIndex={-1}
          className="ub-setting-copy ub-muted ub-forget-note"
          role="status"
        >
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * The dialog. Rendered only while open — an overlay nobody asked for should not
 * be in the tree at all.
 *
 * `workspace` is the one the address names, so Storage can refuse to forget it.
 */
export function SettingsDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace | null;
  onClose: () => void;
}): ReactElement {
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
        <section className="ub-settings-section" aria-labelledby="ub-settings-storage">
          <h3 id="ub-settings-storage" className="ub-settings-section-title">
            Storage
          </h3>
          <WorkspaceStorage workspace={workspace} />
        </section>
      </div>
    </div>
  );
}
