/**
 * SPIKE: a minimal wireframe-md v2 parser and DOM renderer.
 *
 * This file stands in for the future `@wireframe-md/core` + `@wireframe-md/html`
 * packages so the editor integration can be proven before those exist. It
 * implements a subset of the proposed grammar, enough for the reference screens:
 *
 *   <indent><kind>[.variant…][#id] [key=value…] [label]
 *   "free text line          - list item          | table | row
 *   // comment
 *   inline: **bold** *italic* `mono` ==mark== [Button] {chip} :icon:
 *
 * Properties the integration relies on, which the real package must keep:
 * - Never throws on any input. An unknown kind draws as a dashed labelled box;
 *   a line that is not an element is drawn as text. Problems become diagnostics
 *   with a 1-based line number.
 * - Builds DOM with createElement/textContent only. No innerHTML, no inline
 *   style from source text except bounded numbers, no URLs or raw CSS.
 * - Output is inert: mock controls are spans, nothing is focusable.
 * - Bounded work: size, line, depth and node limits.
 * - All styling lives under `.wf-root` (src/ui/wireframe.css).
 */

export interface WfNode {
  kind: string;
  variants: string[];
  attrs: Record<string, string>;
  label: string;
  cells?: string[];
  line: number;
  children: WfNode[];
}

export interface WfDiagnostic {
  line: number;
  message: string;
}

export interface WfParse {
  roots: WfNode[];
  diagnostics: WfDiagnostic[];
  /** Set when a limit stopped parsing; the caller keeps its last good render. */
  overLimit: string | null;
}

export const WF_LIMITS = { chars: 64_000, lines: 2_000, depth: 24, nodes: 2_000 } as const;

const LEAVES = new Set([
  "button", "input", "search", "dropdown", "select", "date", "textarea", "checkbox", "radio", "switch", "toggle",
  "progress", "stars", "tabs", "avatar", "image", "video", "map", "chart", "icon", "chip", "tag", "pill", "badge",
  "dot", "note", "kv", "spacer", "line", "divider", "lorem", "title", "h1", "h2", "h3", "link", "tr",
]);
const HEAD = /^([a-z][a-z0-9-]*)((?:\.[a-z0-9-]+)*)(#[A-Za-z0-9_-]+)?$/;
const ATTR = /^([a-z][a-z0-9-]*)=("(?:[^"\\]|\\.)*"|\S+)(?:\s+|$)/;

export function parseWireframe(source: string): WfParse {
  const diagnostics: WfDiagnostic[] = [];
  const roots: WfNode[] = [];
  if (source.length > WF_LIMITS.chars) {
    return { roots, diagnostics, overLimit: `Source is longer than ${WF_LIMITS.chars} characters` };
  }
  const lines = source.split("\n");
  if (lines.length > WF_LIMITS.lines) {
    return { roots, diagnostics, overLimit: `Source has more than ${WF_LIMITS.lines} lines` };
  }
  const stack: { depth: number; node: WfNode }[] = [];
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const lineNo = index + 1;
    if (raw.trim() === "" || raw.trimStart().startsWith("//")) continue;
    const leading = /^[ \t]*/.exec(raw)?.[0] ?? "";
    if (leading.includes("\t")) diagnostics.push({ line: lineNo, message: "Tab in indentation; use two spaces" });
    const width = leading.replace(/\t/g, "  ").length;
    if (width % 2 === 1) diagnostics.push({ line: lineNo, message: "Odd indentation; children are indented two spaces" });
    let depth = Math.floor(width / 2);
    const parentDepth = stack.length === 0 ? -1 : (stack[stack.length - 1]?.depth ?? -1);
    if (depth > parentDepth + 1) {
      diagnostics.push({ line: lineNo, message: "Indented more than one level below the line above" });
      depth = parentDepth + 1;
    }
    if (depth >= WF_LIMITS.depth) {
      return { roots, diagnostics, overLimit: `Nesting deeper than ${WF_LIMITS.depth} levels at line ${lineNo}` };
    }
    count += 1;
    if (count > WF_LIMITS.nodes) {
      return { roots, diagnostics, overLimit: `More than ${WF_LIMITS.nodes} elements` };
    }
    const node = parseLine(raw.trim(), lineNo, diagnostics);
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop();
    // A leaf cannot hold children: draw the line after it rather than drop it.
    while (stack.length > 0 && LEAVES.has(stack[stack.length - 1]?.node.kind ?? "")) {
      const leaf = stack.pop();
      diagnostics.push({ line: lineNo, message: `${leaf?.node.kind} takes no children; drawn after it` });
      depth = leaf?.depth ?? depth;
    }
    const parent = stack[stack.length - 1]?.node;
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push({ depth, node });
  }
  return { roots, diagnostics, overLimit: null };
}

function parseLine(content: string, line: number, diagnostics: WfDiagnostic[]): WfNode {
  const node = (kind: string, label: string): WfNode =>
    ({ kind, variants: [], attrs: {}, label, line, children: [] });
  if (content.startsWith("\"")) return node("text", content.slice(1).replace(/"$/, ""));
  if (content === "-" || content.startsWith("- ")) return node("li", content.slice(2));
  if (content.startsWith("|")) {
    const cells = content.replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
    return { ...node("tr", ""), cells };
  }
  const space = content.search(/\s/);
  const head = space === -1 ? content : content.slice(0, space);
  const match = HEAD.exec(head);
  if (match === null) {
    diagnostics.push({ line, message: `"${head.slice(0, 24)}" is not an element; drawn as text` });
    return node("text", content);
  }
  const result = node(match[1] ?? "box", "");
  result.variants = (match[2] ?? "").split(".").filter(Boolean);
  if (match[3] !== undefined) result.attrs.id = match[3].slice(1);
  let rest = space === -1 ? "" : content.slice(space).trimStart();
  for (let attr = ATTR.exec(rest); attr !== null; attr = ATTR.exec(rest)) {
    const key = attr[1] ?? "";
    let value = attr[2] ?? "";
    if (value.startsWith("\"")) value = value.slice(1, -1).replace(/\\(.)/g, "$1");
    if (key in result.attrs) diagnostics.push({ line, message: `Attribute ${key} given twice; the last one wins` });
    result.attrs[key] = value;
    rest = rest.slice(attr[0].length);
  }
  if (rest.startsWith("\"") && rest.endsWith("\"") && rest.length >= 2) rest = rest.slice(1, -1);
  result.label = rest;
  return result;
}

/* ------------------------------------------------------------------ icons */

// 16×16 stroke icons. Names are an allowlist; anything else draws as a dot.
const ICONS: Record<string, string> = {
  "chevron-right": "M6 3l5 5-5 5",
  "chevron-down": "M3 6l5 5 5-5",
  "chevron-up": "M3 10l5-5 5 5",
  "chevron-left": "M10 3L5 8l5 5",
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  chat: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  search: "M10.2 10.2L14 14M11.2 7a4.2 4.2 0 1 1-8.4 0 4.2 4.2 0 0 1 8.4 0z",
  user: "M3 14c.6-3 2.5-4.3 5-4.3s4.4 1.3 5 4.3M10.6 5.5a2.6 2.6 0 1 1-5.2 0 2.6 2.6 0 0 1 5.2 0z",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  check: "M3 8.5l3 3 7-7",
  home: "M2.5 8L8 3l5.5 5M4.5 7v6h7V7",
  fire: "M8 2c1 2.5 4 3.8 4 7a4 4 0 0 1-8 0c0-1.6.8-2.5 1.5-3.4.3 1 .8 1.6 1.5 1.9C7 5.5 7.4 3.7 8 2z",
  book: "M2.5 3.5h4.5a1 1 0 0 1 1 1v9a1 1 0 0 0-1-1H2.5zM13.5 3.5H9a1 1 0 0 0-1 1v9a1 1 0 0 1 1-1h4.5z",
  pin: "M9.5 2l4.5 4.5-2 1-2.5 2.5v3l-1.5-1.5-3 3-1-1 3-3L5.5 9h3l2.5-2.5z",
  archive: "M2 3h12v3H2zM3 6v7h10V6M6.5 9h3",
  menu: "M2.5 4h11M2.5 8h11M2.5 12h11",
  bell: "M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3",
  settings: "M8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  swap: "M5 2.5v11M2.5 5 5 2.5 7.5 5M11 13.5v-11M8.5 11l2.5 2.5 2.5-2.5",
  collapse: "M8 3L3 8l5 5M13 3L8 8l5 5",
  doc: "M4 1.5h5l3 3v10H4zM9 1.5v3h3",
  issue: "M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0zM9.2 8a1.2 1.2 0 1 1-2.4 0 1.2 1.2 0 0 1 2.4 0z",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1",
  star: "M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5z",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9",
  edit: "M3 13l.6-2.8L10.8 3l2.2 2.2-7.2 7.2zM9.5 4.3l2.2 2.2",
  calendar: "M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3",
  filter: "M2.5 3.5h11l-4.3 5v4l-2.4 1.5V8.5z",
};

const SVG = "http://www.w3.org/2000/svg";

function icon(doc: Document, name: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "wf-icon");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(SVG, "path");
  const data = ICONS[name];
  if (data === undefined) {
    const dot = doc.createElementNS(SVG, "circle");
    dot.setAttribute("cx", "8");
    dot.setAttribute("cy", "8");
    dot.setAttribute("r", "3");
    svg.append(dot);
    return svg;
  }
  path.setAttribute("d", data);
  svg.append(path);
  return svg;
}

/* ----------------------------------------------------------------- inline */

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|==[^=]+==|\[[^\]]+\]|\{[^}]+\}|:[a-z][a-z0-9-]*:)/g;

function inline(doc: Document, parent: Element, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) parent.append(doc.createTextNode(text.slice(last, at)));
    last = at + token.length;
    const span = (className: string, value: string): void => {
      const element = doc.createElement("span");
      element.className = className;
      element.textContent = value;
      parent.append(element);
    };
    if (token.startsWith("**")) span("wf-strong", token.slice(2, -2));
    else if (token.startsWith("`")) span("wf-code", token.slice(1, -1));
    else if (token.startsWith("==")) span("wf-mark", token.slice(2, -2));
    else if (token.startsWith("[")) span("wf-btn wf-btn-inline", token.slice(1, -1));
    else if (token.startsWith("{")) span("wf-chip", token.slice(1, -1));
    else if (token.startsWith(":")) parent.append(icon(doc, token.slice(1, -1)));
    else span("wf-italic", token.slice(1, -1));
  }
  if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
}

/* --------------------------------------------------------------- renderer */

const HUES = new Set(["neutral", "amber", "red", "green", "blue", "violet", "teal", "rose", "slate"]);
const FRAME_WIDTH: Record<string, number> = { phone: 260, iphone: 260, android: 274, tablet: 520, watch: 140 };

function px(value: string | undefined, min: number, max: number): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return Math.max(min, Math.min(max, Number(value)));
}

function count(value: string | undefined, fallback: number, max: number): number {
  return px(value, 1, max) ?? fallback;
}

interface Context { doc: Document; }

function el(ctx: Context, tag: string, className: string, node?: WfNode): HTMLElement {
  const element = ctx.doc.createElement(tag);
  element.className = className;
  if (node !== undefined) {
    for (const variant of node.variants) element.classList.add(`wf-${variant}`);
    const hue = node.attrs.hue;
    if (hue !== undefined && HUES.has(hue)) element.dataset.hue = hue;
    element.dataset.line = String(node.line);
  }
  return element;
}

function sizing(element: HTMLElement, node: WfNode): void {
  const w = node.attrs.w;
  if (w === "fill") element.classList.add("wf-fill");
  else if (w !== undefined && /^\d{1,3}%$/.test(w)) element.style.flex = `0 0 ${Math.min(100, Number(w.slice(0, -1)))}%`;
  else {
    const width = px(w, 8, 2000);
    if (width !== null) element.style.width = `${width}px`;
  }
  const height = px(node.attrs.h, 8, 2000);
  if (height !== null) element.style.minHeight = `${height}px`;
}

function children(ctx: Context, element: HTMLElement, node: WfNode): HTMLElement {
  for (const child of node.children) element.append(render(ctx, child));
  return element;
}

function labelled(ctx: Context, tag: string, className: string, node: WfNode): HTMLElement {
  const element = el(ctx, tag, className, node);
  if (node.attrs.icon !== undefined) element.append(icon(ctx.doc, node.attrs.icon));
  if (node.label !== "") inline(ctx.doc, element, node.label);
  return element;
}

function render(ctx: Context, node: WfNode): HTMLElement {
  const { doc } = ctx;
  switch (node.kind) {
    case "frame": return frame(ctx, node);
    case "row": case "col": case "stack": {
      const kind = node.kind === "row" ? "row" : "col";
      const element = el(ctx, "div", `wf-${kind}`, node);
      const align = node.attrs.align;
      if (align !== undefined && /^(end|start|center|between|top|stretch)$/.test(align)) element.classList.add(`wf-align-${align}`);
      const gap = node.attrs.gap;
      if (gap === "sm" || gap === "lg" || gap === "none") element.classList.add(`wf-gap-${gap}`);
      sizing(element, node);
      return children(ctx, element, node);
    }
    case "grid": {
      const element = el(ctx, "div", "wf-grid", node);
      element.style.gridTemplateColumns = `repeat(${count(node.attrs.cols, 2, 12)}, minmax(0, 1fr))`;
      return children(ctx, element, node);
    }
    case "spacer": return el(ctx, "div", "wf-spacer", node);
    case "line": case "divider": return el(ctx, "div", node.variants.includes("v") ? "wf-vline" : "wf-line", node);
    case "title": case "h1": return labelled(ctx, "div", "wf-title", node);
    case "h2": case "h3": return labelled(ctx, "div", `wf-${node.kind}`, node);
    case "text": case "p": case "label": {
      const element = labelled(ctx, "div", "wf-text", node);
      sizing(element, node);
      return children(ctx, element, node);
    }
    case "link": return labelled(ctx, "span", "wf-link", node);
    case "lorem": {
      const element = el(ctx, "div", "wf-lorem", node);
      const lines = count(node.attrs.lines, 3, 40);
      for (let index = 0; index < lines; index += 1) element.append(doc.createElement("i"));
      sizing(element, node);
      return element;
    }
    case "button": return labelled(ctx, "span", "wf-btn", node);
    case "buttons": return children(ctx, el(ctx, "div", "wf-row wf-gap-sm", node), node);
    case "input": case "search": case "dropdown": case "select": case "date": {
      const element = el(ctx, "div", "wf-input", node);
      const name = node.attrs.icon ?? (node.kind === "search" ? "search" : undefined);
      if (name !== undefined) element.append(icon(doc, name));
      const placeholder = el(ctx, "span", "wf-placeholder");
      inline(doc, placeholder, node.label);
      element.append(placeholder);
      if (node.kind === "dropdown" || node.kind === "select") element.append(icon(doc, "chevron-down"));
      if (node.kind === "date") element.append(icon(doc, "calendar"));
      sizing(element, node);
      return element;
    }
    case "textarea": {
      const element = el(ctx, "div", "wf-textarea", node);
      element.style.minHeight = `${count(node.attrs.lines, 3, 30) * 20 + 12}px`;
      if (node.label !== "") {
        const placeholder = el(ctx, "span", "wf-placeholder");
        inline(doc, placeholder, node.label);
        element.append(placeholder);
      }
      sizing(element, node);
      return element;
    }
    case "checkbox": case "radio": case "switch": case "toggle": {
      const on = node.variants.includes("on") || node.attrs.checked === "true";
      const element = el(ctx, "span", "wf-check", node);
      const mark = el(ctx, "span", `wf-${node.kind === "toggle" ? "switch" : node.kind}${on ? " wf-on" : ""}`);
      element.append(mark);
      if (node.label !== "") inline(doc, element, node.label);
      return element;
    }
    case "progress": {
      const element = el(ctx, "span", "wf-progress", node);
      const bar = doc.createElement("i");
      bar.style.width = `${px(node.attrs.value, 0, 100) ?? 60}%`;
      element.append(bar);
      return element;
    }
    case "stars": {
      const element = el(ctx, "span", "wf-stars", node);
      const value = px(node.attrs.value, 0, 5) ?? 4;
      element.textContent = "★".repeat(value);
      const off = el(ctx, "span", "wf-stars-off");
      off.textContent = "★".repeat(5 - value);
      element.append(off);
      return element;
    }
    case "tabs": return tabs(ctx, node);
    case "list": {
      const bullets = node.variants.includes("bullets") || node.variants.includes("numbered");
      const element = el(ctx, bullets ? (node.variants.includes("numbered") ? "ol" : "ul") : "div", bullets ? "wf-bullets" : "wf-list", node);
      return children(ctx, element, node);
    }
    case "li": {
      const element = el(ctx, "li", "wf-li", node);
      inline(doc, element, node.label);
      return children(ctx, element, node);
    }
    case "item": {
      const element = labelled(ctx, "div", "wf-item", node);
      return children(ctx, element, node);
    }
    case "box": case "card": case "panel": case "group": case "section": {
      const element = el(ctx, "div", `wf-box${node.kind === "card" ? " wf-card" : ""}${node.kind === "panel" ? " wf-panel" : ""}`, node);
      if (node.attrs.tab !== undefined) {
        const tab = el(ctx, "span", "wf-box-tab");
        tab.textContent = node.attrs.tab;
        element.append(tab);
      }
      if (node.label !== "") {
        const heading = el(ctx, "div", "wf-box-label");
        inline(doc, heading, node.label);
        element.append(heading);
      }
      sizing(element, node);
      return children(ctx, element, node);
    }
    case "banner": case "alert": case "toast": {
      const element = el(ctx, "div", "wf-banner", node);
      element.append(icon(doc, node.attrs.icon ?? "bell"));
      const body = el(ctx, "div", "wf-fill");
      inline(doc, body, node.label);
      element.append(body);
      return children(ctx, element, node);
    }
    case "dialog": case "modal": case "drawer": case "popover": {
      const scrim = el(ctx, "div", "wf-scrim", node);
      const element = el(ctx, "div", "wf-dialog");
      if (node.label !== "") {
        const title = el(ctx, "div", "wf-dialog-title");
        inline(doc, title, node.label);
        element.append(title);
      }
      sizing(element, node);
      scrim.append(children(ctx, element, node));
      return scrim;
    }
    case "avatar": {
      const element = el(ctx, "span", "wf-avatar", node);
      if (/^[A-Za-z]{1,3}$/.test(node.label)) element.textContent = node.label.toUpperCase();
      else element.append(icon(doc, "user"));
      const size = px(node.attrs.w, 16, 400);
      if (size !== null) { element.style.width = `${size}px`; element.style.height = `${size}px`; }
      if (node.attrs.w === "fill") element.classList.add("wf-avatar-fill");
      return element;
    }
    case "image": case "video": case "map": case "chart": {
      const element = el(ctx, "div", `wf-image wf-${node.kind}`, node);
      if (node.label !== "") {
        const caption = el(ctx, "span", "wf-image-label");
        caption.textContent = node.label;
        element.append(caption);
      }
      if (node.kind === "video") element.append(icon(doc, "chevron-right"));
      sizing(element, node);
      return element;
    }
    case "icon": {
      const element = el(ctx, "span", "wf-icon-box", node);
      element.append(icon(doc, node.label.trim() || node.attrs.name || "more"));
      return element;
    }
    case "chip": case "tag": case "pill": case "badge": return labelled(ctx, "span", node.kind === "pill" ? "wf-pill" : "wf-chip", node);
    case "dot": return el(ctx, "span", "wf-dot", node);
    case "note": return labelled(ctx, "div", "wf-note", node);
    case "kv": {
      const element = el(ctx, "div", "wf-kv", node);
      const [key, ...rest] = node.label.split(":");
      const k = el(ctx, "span", "wf-kv-key");
      k.textContent = key ?? "";
      const v = el(ctx, "span", "wf-kv-value");
      inline(doc, v, rest.join(":").trim());
      element.append(k, v);
      return element;
    }
    case "table": {
      const table = el(ctx, "table", "wf-table", node);
      let header = !node.variants.includes("headless");
      for (const child of node.children) {
        if (child.kind !== "tr") { table.append(render(ctx, child)); continue; }
        const row = doc.createElement("tr");
        for (const cell of child.cells ?? []) {
          const td = doc.createElement(header ? "th" : "td");
          inline(doc, td, cell);
          row.append(td);
        }
        table.append(row);
        header = false;
      }
      return table;
    }
    case "tr": {
      const row = el(ctx, "div", "wf-row", node);
      for (const cell of node.cells ?? []) {
        const span = el(ctx, "span", "wf-text");
        inline(doc, span, cell);
        row.append(span);
      }
      return row;
    }
    default: {
      const element = el(ctx, "div", "wf-unknown", node);
      const name = el(ctx, "span", "wf-unknown-kind");
      name.textContent = node.kind;
      element.append(name);
      if (node.label !== "") inline(doc, element, ` ${node.label}`);
      return children(ctx, element, node);
    }
  }
}

function frame(ctx: Context, node: WfNode): HTMLElement {
  const variant = node.variants.find(name => name in FRAME_WIDTH || name === "window" || name === "phone");
  const wrapper = el(ctx, "figure", "wf-frame-wrap");
  if (node.label !== "") {
    const caption = el(ctx, "figcaption", "wf-frame-caption");
    caption.textContent = node.label;
    wrapper.append(caption);
  }
  const body = el(ctx, "div", "wf-frame", node);
  const fixed = px(node.attrs.w, 120, 1600) ?? (variant !== undefined ? FRAME_WIDTH[variant] : undefined);
  if (fixed !== undefined && fixed !== null) {
    wrapper.style.width = `${fixed}px`;
    wrapper.classList.add("wf-fixed");
  } else wrapper.classList.add("wf-fluid");
  if (variant === "phone" || variant === "iphone" || variant === "android") {
    body.classList.add("wf-device");
    const bar = el(ctx, "div", "wf-statusbar");
    const time = ctx.doc.createElement("span");
    time.textContent = "9:41";
    const notch = ctx.doc.createElement("b");
    const signal = ctx.doc.createElement("span");
    signal.textContent = "●●●";
    bar.append(time, notch, signal);
    body.append(bar);
  }
  if (variant === "window") {
    const bar = el(ctx, "div", "wf-titlebar");
    bar.append(ctx.doc.createElement("i"), ctx.doc.createElement("i"), ctx.doc.createElement("i"));
    if (node.attrs.url !== undefined) {
      const url = el(ctx, "span", "wf-url");
      url.textContent = node.attrs.url;
      bar.append(url);
    }
    body.append(bar);
  }
  const content = el(ctx, "div", "wf-frame-body");
  const height = px(node.attrs.h, 40, 4000);
  if (height !== null) content.style.minHeight = `${height}px`;
  body.append(children(ctx, content, node));
  wrapper.append(body);
  return wrapper;
}

function tabs(ctx: Context, node: WfNode): HTMLElement {
  const style = node.variants.find(name => ["segmented", "underline", "bar", "vertical", "pills"].includes(name)) ?? "segmented";
  const element = el(ctx, "span", `wf-tabs wf-tabs-${style}`, node);
  const items = node.label.split("|").map(item => item.trim()).filter(Boolean);
  const active = node.attrs.active;
  items.forEach((item, index) => {
    const tab = el(ctx, "span", "wf-tab");
    const plain = item.replace(/:[a-z][a-z0-9-]*:/g, "").trim();
    if (active === undefined ? index === 0 : plain === active) tab.classList.add("wf-on");
    inline(ctx.doc, tab, item);
    element.append(tab);
  });
  return element;
}

/** Render a parse into a fresh `.wf-root`. Frames sit side by side on a board. */
export function renderWireframe(parse: WfParse, doc: Document = document): HTMLElement {
  const ctx: Context = { doc };
  const root = doc.createElement("div");
  root.className = "wf-root";
  const board = doc.createElement("div");
  board.className = "wf-board";
  root.append(board);
  // Roots that are not frames share one implicit fluid frame, in order.
  let loose: WfNode | null = null;
  for (const node of parse.roots) {
    if (node.kind === "frame") {
      loose = null;
      board.append(frame(ctx, node));
      continue;
    }
    if (loose === null) {
      loose = { kind: "frame", variants: [], attrs: {}, label: "", line: node.line, children: [] };
      const wrapper = frame(ctx, loose);
      wrapper.classList.add("wf-implicit");
      board.append(wrapper);
    }
    const body = board.lastElementChild?.querySelector(".wf-frame-body");
    body?.append(render(ctx, node));
  }
  return root;
}

/** One sentence for assistive technology: what the wireframe shows. */
export function wireframeSummary(parse: WfParse): string {
  const frames = parse.roots.filter(node => node.kind === "frame");
  let elements = 0;
  const walk = (node: WfNode): void => { elements += 1; node.children.forEach(walk); };
  parse.roots.forEach(walk);
  const names = frames.map(node => node.label).filter(Boolean);
  const screens = frames.length <= 1 ? "one screen" : `${frames.length} screens`;
  return `Wireframe, ${screens}${names.length > 0 ? ` (${names.join(", ")})` : ""}, ${elements} elements`;
}
