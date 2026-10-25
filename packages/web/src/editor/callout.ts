import { Node, mergeAttributes } from "@tiptap/core";
import { isCalloutIcon, isCalloutVariant } from "@uberblick/schema";
import type { CalloutVariant, InlineIconName } from "@uberblick/schema";
import { inlineIconSvg } from "../inline-icons.js";
import { PROSE_MARKS } from "./marks.js";
import { blockCaption, chromeFilters } from "./source-chrome.js";

const labels: Record<CalloutVariant, string> = {
  note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution",
};

const shapes: Record<CalloutVariant, string> = {
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  tip: '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2Z"/>',
  important: '<path d="M20 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3v3l4-3h9a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2ZM12 7v5m0 3v.01"/>',
  warning: '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 3v.01"/>',
  caution: '<path d="M8 2h8l6 6v8l-6 6H8l-6-6V8l6-6Zm4 5v6m0 4v.01"/>',
};

function variantOf(raw: unknown): CalloutVariant {
  return isCalloutVariant(raw) ? raw : "note";
}

/** Keep unknown values and absence intact; only the drawing uses fallbacks. */
function storedAttribute(key: string, name = key) {
  return {
    default: null as string | null,
    parseHTML: (element: HTMLElement): string | null => element.getAttribute(name),
    renderHTML: (attributes: Record<string, unknown>): Record<string, string> => {
      const value = attributes[key];
      return typeof value === "string" ? { [name]: value } : {};
    },
  };
}

let nextIconId = 0;
function captionIcon(variant: CalloutVariant, raw: unknown): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "ub-callout-icon";
  icon.setAttribute("aria-hidden", "true");
  if (isCalloutIcon(raw)) {
    if (raw.startsWith(":")) {
      const name = raw.slice(1, -1) as InlineIconName;
      icon.classList.add("ub-inline-icon");
      icon.dataset.icon = name;
      icon.innerHTML = inlineIconSvg(name, `ub-callout-icon-${nextIconId++}`);
    } else icon.textContent = raw;
  } else {
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${shapes[variant]}</svg>`;
  }
  icon.querySelector("svg")?.setAttribute("aria-hidden", "true");
  return icon;
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "inline*",
  marks: PROSE_MARKS,
  addAttributes() {
    return {
      id: storedAttribute("id"),
      variant: storedAttribute("variant", "data-variant"),
      icon: storedAttribute("icon", "data-icon"),
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-block-type="callout"]', contentElement: ".ub-callout-body" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Clipboard serialization contains authored prose, never the caption.
    return ["div", mergeAttributes(HTMLAttributes, {
      class: "ub-callout ub-block-frame",
      "data-block-type": "callout",
      role: "note",
      "aria-label": labels[variantOf(node.attrs.variant)],
    }), ["div", { class: "ub-callout-body" }, 0]];
  },
  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement("div");
      dom.className = "ub-callout ub-block-frame";
      dom.dataset.blockType = "callout";
      dom.setAttribute("role", "note");
      const caption = blockCaption("");
      const contentDOM = document.createElement("div");
      contentDOM.className = "ub-callout-body";
      dom.append(caption.row, contentDOM);
      const draw = (): void => {
        const variant = variantOf(current.attrs.variant);
        dom.setAttribute("aria-label", labels[variant]);
        for (const [key, attr] of [["id", "id"], ["variant", "data-variant"], ["icon", "data-icon"]] as const) {
          const value: unknown = current.attrs[key];
          if (typeof value === "string") dom.setAttribute(attr, value);
          else dom.removeAttribute(attr);
        }
        caption.label.replaceChildren(captionIcon(variant, current.attrs.icon), document.createTextNode(labels[variant]));
      };
      draw();
      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type !== current.type || contentDOM.parentNode !== dom) return false;
          const changed = updated.attrs.variant !== current.attrs.variant || updated.attrs.icon !== current.attrs.icon || updated.attrs.id !== current.attrs.id;
          current = updated;
          if (changed) draw();
          return true;
        },
        ...chromeFilters(dom, [caption.row]),
      };
    };
  },
});
