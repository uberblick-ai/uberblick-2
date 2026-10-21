const HISTORY_KEY = "ubDiagramViewer";
let nextViewer = 0;

/** Keep viewer dismissal separate from the document's own navigation. */
export function figureHistory(dispose: () => void): { close: () => void } {
  const entry = ++nextViewer;
  const state: unknown = window.history.state;
  window.history.pushState({ ...(state !== null && typeof state === "object" ? state : {}), [HISTORY_KEY]: entry }, "");
  let disposed = false;
  let closing = false;
  const popped = (): void => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("popstate", popped);
    dispose();
  };
  window.addEventListener("popstate", popped);
  return { close: () => {
    if (disposed || closing) return;
    closing = true;
    // Consume our same-address entry, preserving the document's route state.
    // As with any pushState, opening has already discarded forward entries.
    if (window.history.state?.[HISTORY_KEY] === entry) window.history.back();
    else popped();
  } };
}
