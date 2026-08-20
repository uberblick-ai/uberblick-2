/**
 * @uberblick/web — browser entry point.
 *
 * StrictMode is deliberately absent. Its double-invoked effects open every
 * WebSocket, IndexedDB replica and ProseMirror binding twice, which for a
 * live-sync spike means the presence strip and awareness state lie in dev but
 * not in production. Room connections are refcounted (see collab/rooms.ts), so
 * turning StrictMode back on is safe; the noise just is not worth it here.
 */

import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import "./ui/styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from index.html");
}

createRoot(container).render(<App />);
