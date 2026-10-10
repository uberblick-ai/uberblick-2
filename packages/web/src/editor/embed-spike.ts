/**
 * SPIKE ONLY (spikes/embeds, never merged). A code block whose language is
 * `embed` renders its single-line URL as the embed frame from the Figma block
 * proposal: caption, a frame that is inert until clicked, and the source line
 * underneath as the block's editable content. No schema, Markdown or MCP
 * change. Every iframe load and node view lifetime is counted on
 * `window.__embedSpike` so the e2e spike can see reloads.
 *
 * The theme is read once, when the view is created: following a theme switch
 * would mean a new src, which is a reload.
 */
import type { NodeViewRenderer, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { resolveEmbed } from "../../../../spikes/embeds/providers.js";

interface SpikeProbe {
  created: { instance: number; block: string; t: number }[];
  destroyed: { instance: number; block: string; t: number }[];
  loads: { instance: number; block: string; src: string; t: number }[];
  srcChanges: { instance: number; block: string; src: string; t: number }[];
  domMoves: { instance: number; block: string; t: number }[];
}

function probe(): SpikeProbe {
  const host = window as unknown as { __embedSpike?: SpikeProbe };
  host.__embedSpike ??= { created: [], destroyed: [], loads: [], srcChanges: [], domMoves: [] };
  return host.__embedSpike;
}

let instances = 0;
let active: { frame: HTMLElement; release: () => void } | null = null;
document.addEventListener("mousedown", (event) => {
  if (active !== null && !(event.target instanceof Node && active.frame.contains(event.target))) active.release();
}, true);

export function embedBlockView(fallback: NodeViewRenderer): NodeViewRenderer {
  return (props: NodeViewRendererProps): NodeView => {
    if (props.node.attrs.language !== "embed") return fallback(props) as NodeView;
    let current: PMNode = props.node;
    const instance = ++instances;
    const block = (): string => String(current.attrs.id ?? "");
    const now = (): number => Math.round(performance.now());
    const dark = document.documentElement.dataset.theme === "dark" ||
      (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    const theme = dark ? "dark" : "light";

    const dom = document.createElement("div");
    dom.className = "ub-embed-spike";
    dom.style.cssText = "margin: 0.75em 0; border-left: 3px solid oklch(0.62 0.1 190); border-radius: 0 8px 8px 0; background: color-mix(in oklch, oklch(0.62 0.1 190) 8%, transparent); padding: 0 0 6px;";
    const chrome = document.createElement("div");
    chrome.contentEditable = "false";
    const cap = document.createElement("div");
    cap.style.cssText = "display: flex; gap: 8px; align-items: center; padding: 6px 10px; font-size: 12px;";
    const label = document.createElement("strong");
    const title = document.createElement("span");
    title.style.cssText = "flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    const open = document.createElement("a");
    open.textContent = "Open";
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    cap.append(label, title, open);
    const frame = document.createElement("div");
    frame.style.cssText = "position: relative; margin: 0 8px; border-radius: 6px; overflow: hidden; background: color-mix(in oklch, currentColor 8%, transparent);";
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%; border: 0;";
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("allowfullscreen", "");
    iframe.dataset.instance = String(instance);
    const shield = document.createElement("button");
    shield.type = "button";
    shield.setAttribute("aria-label", "Interact with embed");
    shield.style.cssText = "position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: transparent; cursor: pointer;";
    const refused = document.createElement("p");
    refused.style.cssText = "margin: 0 10px; font-size: 13px; opacity: 0.7;";
    frame.append(iframe, shield);
    chrome.append(cap, frame, refused);
    const contentDOM = document.createElement("code");
    contentDOM.style.cssText = "display: block; margin: 4px 10px 0; font-size: 11px; opacity: 0.7; white-space: pre-wrap; overflow-wrap: anywhere;";
    dom.append(chrome, contentDOM);

    const release = (): void => {
      shield.hidden = false;
      frame.style.outline = "";
      if (active?.frame === frame) active = null;
    };
    shield.addEventListener("mousedown", (event) => event.preventDefault());
    shield.addEventListener("click", () => {
      active?.release();
      shield.hidden = true;
      frame.style.outline = "2px solid currentColor";
      active = { frame, release };
      iframe.focus();
    });
    iframe.addEventListener("load", () => {
      probe().loads.push({ instance, block: block(), src: iframe.getAttribute("src") ?? "", t: now() });
    });

    // Moving an iframe's element in the DOM reloads it in every engine, so
    // record when this view's root is (re)attached.
    let attached = false;
    const attachment = new MutationObserver(() => {
      const connected = dom.isConnected;
      if (connected && attached) return;
      if (connected) probe().domMoves.push({ instance, block: block(), t: now() });
      attached = connected;
    });

    const render = (): void => {
      if (typeof current.attrs.id === "string") dom.id = current.attrs.id;
      const raw = current.textContent.trim();
      const hit = resolveEmbed(raw, { theme });
      open.href = raw;
      if (hit === null) {
        frame.hidden = true;
        label.textContent = "Embed";
        title.textContent = "";
        refused.textContent = raw === "" ? "Paste a Figma, YouTube or Loom link." : "Not a supported embed link.";
        refused.hidden = false;
        return;
      }
      refused.hidden = true;
      frame.hidden = false;
      label.textContent = hit.provider.label;
      title.textContent = `${hit.title} · ${hit.kind}`;
      const shape = hit.provider.shape;
      if (shape.aspect !== undefined) { frame.style.aspectRatio = String(shape.aspect); frame.style.height = ""; }
      else { frame.style.height = `${shape.height ?? 360}px`; frame.style.aspectRatio = ""; }
      iframe.setAttribute("sandbox", hit.provider.sandbox);
      iframe.setAttribute("allow", hit.provider.allow);
      iframe.setAttribute("referrerpolicy", hit.provider.referrerPolicy);
      iframe.title = `${hit.provider.label}: ${hit.title}`;
      const src = hit.candidates[0] ?? "";
      if (iframe.getAttribute("src") !== src) {
        iframe.setAttribute("src", src);
        probe().srcChanges.push({ instance, block: block(), src, t: now() });
      }
    };

    render();
    probe().created.push({ instance, block: block(), t: now() });
    queueMicrotask(() => {
      attached = dom.isConnected;
      if (attached) probe().domMoves.push({ instance, block: block(), t: now() });
      attachment.observe(document, { childList: true, subtree: true });
    });

    return {
      dom,
      contentDOM,
      update(updated: PMNode): boolean {
        if (updated.type !== current.type || updated.attrs.language !== "embed") return false;
        if (contentDOM.parentNode !== dom) return false;
        current = updated;
        render();
        return true;
      },
      stopEvent: (event: Event): boolean => event.target instanceof Node && chrome.contains(event.target),
      ignoreMutation: (mutation): boolean =>
        chrome.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === dom),
      destroy: () => {
        attachment.disconnect();
        if (active?.frame === frame) active = null;
        probe().destroyed.push({ instance, block: block(), t: now() });
      },
    };
  };
}
