/** Play control for an ablauf drawing: ablauf's own controls, mounted under it when it nears view or on demand. */
import type { Timeline } from "@uberblick/ablauf";
import type { PlaybackMount } from "@uberblick/ablauf/playback";
import playbackUrl from "./ablauf-playback-url.js";
import { lazyRenderer } from "./source-chrome.js";

const playbacks = lazyRenderer(() => import("@uberblick/ablauf/playback"), playbackUrl);
// Load the controls a little before the drawing is reached, so ablauf can start it once half is in view.
const NEAR_VIEW = "200px 0px";
// ablauf's controls pick their own scheme from the system preference; the
// host palette follows the app's appearance instead, which may be pinned.
const HOST_STYLE = ".ab-playback.ab-playback.ab-playback { color-scheme: inherit; background: transparent; font-family: var(--font-sans); }"
  + " .ab-playback button { font-family: var(--font-mono); }";

export interface AblaufPlayback {
  /**
   * Toolbar toggle: Play mounts the controls and starts, Stop removes them.
   * The first time a playable drawing comes into view it plays once on its own; Stop keeps it static.
   */
  readonly play: HTMLButtonElement;
  /** Touch pointers get no toolbar, so a playable drawing offers Play under it. */
  readonly touchPlay: HTMLButtonElement;
  readonly controls: HTMLElement;
  /** Follow a redraw; open controls mount again on the new drawing, waiting for the reader. */
  redraw(svg: SVGSVGElement | null, timelines: Timeline[]): void;
  destroy(): void;
}

function playButton(className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = "Play";
  button.setAttribute("aria-label", "Play ablauf diagram");
  button.hidden = true;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

export function ablaufPlayback(column: HTMLElement, failed: (cause: unknown) => void): AblaufPlayback {
  let svg: SVGSVGElement | null = null;
  let timelines: Timeline[] = [];
  let mount: PlaybackMount | null = null;
  let wanted = false;
  let destroyed = false;
  let nearView = false;
  // Each drawing starts on its own once; after that the reader or a redraw decides.
  let autoplayed = false;
  const play = playButton("ub-ablauf-play");
  play.setAttribute("aria-pressed", "false");
  const touchPlay = playButton("ub-ablauf-touch-play");
  const controls = document.createElement("div");
  controls.className = "ub-ablauf-playback";
  controls.hidden = true;
  const root = controls.attachShadow({ mode: "open" });
  // The controls may grow past a narrow drawing, up to the column.
  const resize = new ResizeObserver(() => {
    controls.style.setProperty("--ub-ablauf-column", `${column.getBoundingClientRect().width}px`);
  });
  resize.observe(column);

  const show = (): void => {
    const playing = mount !== null;
    play.textContent = playing ? "Stop" : "Play";
    play.setAttribute("aria-label", playing ? "Stop playing ablauf diagram" : "Play ablauf diagram");
    play.setAttribute("aria-pressed", String(playing));
    play.hidden = timelines.length === 0;
    touchPlay.hidden = timelines.length === 0 || playing;
    controls.hidden = !playing;
  };
  const unmount = (): void => {
    mount?.destroy();
    mount = null;
    root.replaceChildren();
  };
  const mountOn = (start: boolean, autoplay = false): void => {
    const module = playbacks.current();
    unmount();
    if (module === null || svg === null || timelines.length === 0) return;
    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    root.append(style);
    mount = module.mountPlayback(root, svg, timelines, { autoplay });
    if (start) mount.player.play();
  };
  const open = (start: boolean, autoplay: boolean): void => {
    wanted = true;
    playbacks.load().then(() => {
      if (destroyed || !wanted || mount !== null) return;
      mountOn(start, autoplay);
      show();
    }, (cause: unknown) => {
      wanted = false;
      if (!destroyed) failed(cause);
    });
  };
  const toggle = (): void => {
    if (destroyed || timelines.length === 0) return;
    autoplayed = true;
    if (mount !== null) {
      wanted = false;
      unmount();
      show();
      return;
    }
    open(true, false);
  };
  // ablauf's autoplay leaves a figure still under reduced motion; the reader keeps Play instead.
  const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const autoplay = (): void => {
    if (autoplayed || destroyed || !nearView || timelines.length === 0 || mount !== null || reducedMotion()) return;
    autoplayed = true;
    view.disconnect();
    open(false, true);
  };
  const view = new IntersectionObserver((entries) => {
    nearView = entries.some((entry) => entry.isIntersecting);
    autoplay();
  }, { rootMargin: NEAR_VIEW });
  view.observe(column);
  play.addEventListener("click", toggle);
  touchPlay.addEventListener("click", toggle);

  return {
    play, touchPlay, controls,
    redraw(drawn, resolved) {
      svg = drawn;
      timelines = resolved;
      if (timelines.length === 0) wanted = false;
      if (wanted) mountOn(false);
      else unmount();
      show();
      autoplay();
    },
    destroy() {
      destroyed = true;
      resize.disconnect();
      view.disconnect();
      unmount();
    },
  };
}

/** The viewer shows the whole figure, not a frozen playback step. */
export function withoutPlayback(root: ParentNode): void {
  for (const svg of root.querySelectorAll("svg")) svg.classList.remove("ab-playing", "ab-in-progress");
  for (const part of root.querySelectorAll("[data-ab-part]")) part.classList.remove("ab-current", "ab-played");
}
