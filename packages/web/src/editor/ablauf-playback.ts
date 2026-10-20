/** Play controls for an ablauf block whose source ends with a play section. */

// Playback ships after ablauf 0.2.0. Until the dependency carries it, a block
// with a play section draws as before and shows no Play control.
export interface TimelineStep { parts: string[]; ms: number; caption: string }
interface Player {
  readonly index: number; readonly playing: boolean;
  play(): void; pause(): void; seek(index: number): void; destroy(): void;
}
type CreatePlayer = (svg: Element, timeline: TimelineStep[], options: { onChange?: (player: Player) => void }) => Player;

export interface Playback {
  /** The header's Play button, hidden while the drawing has no timeline. */
  button: HTMLButtonElement;
  /** The step scrubber and caption, shown under the drawing. */
  panel: HTMLDivElement;
  /** Starts over on a freshly drawn SVG; a redraw replaces the old one. */
  attach(svg: Element, timeline: TimelineStep[], renderer: object): void;
  destroy(): void;
}

export function playbackControls(): Playback {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Play";
  button.hidden = true;
  const panel = document.createElement("div");
  panel.className = "ub-ablauf-playback";
  panel.hidden = true;
  const steps = document.createElement("div");
  steps.className = "ub-ablauf-steps";
  const caption = document.createElement("p");
  caption.className = "ub-ablauf-step-caption";
  caption.setAttribute("aria-live", "polite");
  panel.append(steps, caption);
  let player: Player | null = null;
  let timeline: TimelineStep[] = [];

  const show = (p: Player): void => {
    button.textContent = p.playing ? "Pause" : "Play";
    button.setAttribute("aria-pressed", String(p.playing));
    caption.textContent = p.index >= 0 ? timeline[p.index]?.caption ?? "" : "";
    [...steps.children].forEach((step, k) => {
      step.className = k === p.index ? "on" : k < p.index ? "done" : "";
      step.setAttribute("aria-current", String(k === p.index));
    });
  };
  button.addEventListener("mousedown", event => event.preventDefault());
  button.addEventListener("click", event => {
    event.preventDefault();
    if (player === null) return;
    if (player.playing) player.pause(); else player.play();
  });

  return {
    button, panel,
    attach(svg, next, renderer) {
      player?.destroy();
      player = null;
      timeline = next;
      const create = "createPlayer" in renderer ? renderer.createPlayer as CreatePlayer : null;
      const playable = create !== null && next.length > 0;
      button.hidden = !playable;
      panel.hidden = !playable;
      steps.replaceChildren();
      caption.textContent = "";
      if (!playable) return;
      player = create(svg, next, { onChange: show });
      next.forEach((step, k) => {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.setAttribute("aria-label", `Step ${k + 1} of ${next.length}${step.caption ? `: ${step.caption}` : ""}`);
        jump.addEventListener("click", () => { player?.pause(); player?.seek(k); });
        steps.append(jump);
      });
      show(player);
    },
    destroy() { player?.destroy(); player = null; },
  };
}
