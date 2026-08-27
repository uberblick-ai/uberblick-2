/**
 * @uberblick/web — browser entry point.
 *
 * The hub endpoint and the workspaces come from a document this origin serves
 * (see config.ts), so the read is started here, before React mounts — the
 * earliest moment there is. It gates the first *connect*, not the render:
 * `useHubEndpoint` holds room acquisition until it settles, because a room
 * acquired early would dial the fallback and stay there.
 *
 * StrictMode is deliberately absent. Its double-invoked effects open every
 * WebSocket, IndexedDB replica and ProseMirror binding twice, which for a
 * live-sync spike means the presence strip and awareness state lie in dev but
 * not in production. Room connections are refcounted (see collab/rooms.ts), so
 * turning StrictMode back on is safe; the noise just is not worth it here.
 */

import { createRoot } from "react-dom/client";
import { resolveClientConfig } from "./config.js";
import { App } from "./ui/App.js";
import { applyStoredAppearance } from "./ui/theme.js";
import "./ui/styles.css";
// The app's own surfaces are the plain CSS above; this is the chrome
// framework the vendored shadcn components need (#27). It is imported after,
// and everything it emits is inside a cascade layer, so it cannot reach a
// `.ub-*` rule — see ui/tailwind.css.
import "./ui/tailwind.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from index.html");
}

// Memoised in config.ts, and it never rejects — the hook below joins this same
// read rather than starting a second one.
void resolveClientConfig();

// Not the first-paint path — this module is deferred, and `index.html`'s
// blocking snippet is what stamps the attribute before anything is painted
// (#74). This is the runtime owner catching up with it: one read at startup, so
// the module's view and the document agree from the first render, and the
// attribute is still correct if that snippet never ran.
applyStoredAppearance();

createRoot(container).render(<App />);
