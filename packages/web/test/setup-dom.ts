import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "./react-render.js";
import { cleanupTestResources } from "./test-cleanup.js";

// Vitest does not expose global hooks, so Testing Library's automatic setup
// cannot register these. Cleanup runs even when an assertion throws.
const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete reactGlobal.IS_REACT_ACT_ENVIRONMENT;
  } else {
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
afterEach(() => {
  try {
    cleanup();
  } finally {
    cleanupTestResources();
  }
});

/** jsdom has no layout. dnd-kit creates its resize observer at module load. */
if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}
