/**
 * @uberblick/web — browser entry point.
 *
 * The hub endpoint comes from a document this origin serves (see config.ts), so
 * the read is started here, before React mounts — the earliest moment there is.
 * It gates the first *connect*, not the render: `useHubEndpoint` holds room
 * acquisition until it settles, because a room acquired early would dial the
 * fallback and stay there.
 *
 * StrictMode is deliberately absent. Its double-invoked effects open every
 * WebSocket, IndexedDB replica and ProseMirror binding twice, which for a
 * live-sync spike means the presence strip and awareness state lie in dev but
 * not in production. Room connections are refcounted (see collab/rooms.ts), so
 * turning StrictMode back on is safe; the noise just is not worth it here.
 */

import { createRoot } from "react-dom/client";
import { resolveHubUrl } from "./config.js";
import { App } from "./ui/App.js";
import "./ui/styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from index.html");
}

// Memoised in config.ts, and it never rejects — the hook below joins this same
// read rather than starting a second one.
void resolveHubUrl();

createRoot(container).render(<App />);
