/**
 * @uberblick/web — viewer/editor.
 *
 * Scaffold placeholder: renders a title only. The Tiptap/ProseMirror editor
 * (bound to the Y.Doc through y-prosemirror), the Hocuspocus provider
 * connection, y-indexeddb offline caching and awareness rendering are not
 * wired up yet.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main>uberblick web</main>;
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("uberblick web: #root container is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
