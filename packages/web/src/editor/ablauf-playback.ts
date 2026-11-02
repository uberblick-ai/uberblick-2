/** Play control for an ablauf drawing: ablauf's own controls, mounted on demand under it. */
import type { Timeline } from "@uberblick/ablauf";
import type { PlaybackMount } from "@uberblick/ablauf/playback";
import playbackUrl from "./ablauf-playback-url.js";
import { lazyRenderer } from "./source-chrome.js";

const playbacks = lazyRenderer(() => import("@uberblick/ablauf/playback"), playbackUrl);
// ablauf's controls pick their own scheme from the system preference; the
// host palette follows the app's appearance instead, which may be pinned.
const HOST_STYLE = ".ab-playback.ab-playback.ab-playback { color-scheme: inherit; background: transparent; font-family: var(--font-sans); }"
  + " .ab-playback button { font-family: var(--font-mono); }";

export interface AblaufPlayback {
  /** Toolbar toggle: Play mounts the controls and starts, Stop removes them. */
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
  const mountOn = (start: boolean): void => {
    const module = playbacks.current();
    unmount();
    if (module === null || svg === null || timelines.length === 0) return;
    const style = document.createElement("style");
    style.textContent = HOST_STYLE;
    root.append(style);
    mount = module.mountPlayback(root, svg, timelines);
    if (start) mount.player.play();
  };
  const toggle = (): void => {
    if (destroyed || timelines.length === 0) return;
    if (mount !== null) {
      wanted = false;
      unmount();
      show();
      return;
    }
    wanted = true;
    playbacks.load().then(() => {
      if (destroyed || !wanted || mount !== null) return;
      mountOn(true);
      show();
    }, (cause: unknown) => {
      wanted = false;
      if (!destroyed) failed(cause);
    });
  };
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
    },
    destroy() {
      destroyed = true;
      resize.disconnect();
      unmount();
    },
  };
}

/** The viewer shows the whole figure, not a frozen playback step. */
export function withoutPlayback(root: ParentNode): void {
  for (const svg of root.querySelectorAll("svg")) svg.classList.remove("ab-playing", "ab-in-progress");
  for (const part of root.querySelectorAll("[data-ab-part]")) part.classList.remove("ab-current", "ab-played");
}
