import type { Page } from "@playwright/test";
import { alphaOf, composite, contrast, pageGrounds, separation } from "../test/colour.js";

export interface TextReading {
  where: string;
  colour: string;
  ground: string;
  ratio: number;
  /** CSS opacity on the text and its ancestors, independent of colour alpha. */
  opacity: number;
}

interface PaintLayer {
  backgroundColor: string;
  backgroundImage: string;
  opacity: number;
  isBody: boolean;
}

interface BeneathControl {
  at: number;
  branch: PaintLayer[];
}

interface TextPaint {
  where: string;
  colour: string;
  layers: PaintLayer[];
  beneath: BeneathControl[];
}

/**
 * Read enabled text from a rendered surface, including generated labels and
 * field placeholders. The browser supplies paints and visibility; the same
 * Node colour engine as the token table evaluates them without canvas rounding.
 * Both pixels pass through each opacity group: dimming a card changes its
 * backing pixel as well as its text. A positioned control's hit stack supplies
 * sibling backgrounds, such as the terminal screen under its controls.
 */
export async function renderedText(
  page: Page,
  root: string,
  options: { mutedOnly?: boolean } = {},
): Promise<TextReading[]> {
  const snapshot = await readPaint(page, { selector: root, mutedOnly: options.mutedOnly ?? false });
  const grounds = pageGrounds(snapshot.page.backgroundImage, snapshot.page.backgroundColor);
  const readings: TextReading[] = [];
  for (const text of snapshot.text) {
    const beneath = text.beneath.find(({ branch }) => branch.some((entry) =>
      entry.backgroundImage !== "none" || alphaOf(entry.backgroundColor) > 0,
    ));
    const background = (entry: PaintLayer, under: string, pageGround: string): string => {
      if (entry.backgroundImage !== "none") {
        if (!entry.isBody) throw new Error("cannot establish the ground through a painted image");
        return pageGround;
      }
      return composite(entry.backgroundColor, under);
    };
    const painted = (pageGround: string, withText: boolean): string => {
      const paintBranch = (branch: PaintLayer[], index: number, backing: string): string => {
        const entry = branch[index];
        if (entry === undefined) return backing;
        const local = background(entry, backing, pageGround);
        return composite(paintBranch(branch, index + 1, local), backing, entry.opacity);
      };
      const paint = (index: number, backing: string): string => {
        const entry = text.layers[index];
        if (entry === undefined) return withText ? composite(text.colour, backing) : backing;
        let local = background(entry, backing, pageGround);
        if (beneath !== undefined && index === beneath.at) {
          local = paintBranch(beneath.branch, 0, local);
        }
        return composite(paint(index + 1, local), backing, entry.opacity);
      };
      return paint(0, pageGround);
    };
    const opacity = text.layers.reduce((product, entry) => product * entry.opacity, 1);
    const seen = new Set<string>();
    for (const pageGround of grounds) {
      const ground = painted(pageGround, false);
      if (seen.has(ground)) continue;
      seen.add(ground);
      readings.push({
        where: text.where, colour: text.colour, ground,
        ratio: contrast(painted(pageGround, true), ground), opacity,
      });
    }
  }
  return readings;
}

/** The visible OKLab step of a neutral stroke, after its colour alpha. */
export function strokeSeparation(_page: Page, ink: string, ground: string): Promise<number> {
  return Promise.resolve(separation(ink, ground));
}

function readPaint(page: Page, request: { selector: string; mutedOnly: boolean }): Promise<{
  page: Pick<PaintLayer, "backgroundColor" | "backgroundImage">;
  text: TextPaint[];
}> {
  return page.evaluate(({ selector, mutedOnly }) => {
    type Layer = { element: Element; style: CSSStyleDeclaration };
    const start = document.querySelector(selector);
    if (start === null) throw new Error(`no rendered text surface for ${selector}`);
    const name = (element: Element, pseudo: string): string => {
      const classes = element.getAttribute("class")?.trim().split(/\s+/).join(".");
      return `${selector} ${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}${pseudo}`;
    };
    const layer = (element: Element): Layer => ({ element, style: getComputedStyle(element) });
    const pathTo = (element: Element): Layer[] => {
      const path: Layer[] = [];
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        path.unshift(layer(node));
      }
      return path;
    };

    const paints = (path: Layer[]): PaintLayer[] => path.map(({ element, style }) => ({
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      opacity: Number(style.opacity),
      isBody: element === document.body,
    }));
    const visible = (element: Element, path: Layer[]): boolean => {
      if (element.closest("[aria-hidden='true'], [data-disabled], [aria-disabled='true'], :disabled") !== null) {
        return false;
      }
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      let left = Math.max(0, box.left);
      let right = Math.min(innerWidth, box.right);
      let top = Math.max(0, box.top);
      let bottom = Math.min(innerHeight, box.bottom);
      const outsideContainingBlock = new Set<Element>();
      for (const [index, entry] of path.entries()) {
        if (!(entry.element instanceof HTMLElement) ||
          (entry.style.position !== "absolute" && entry.style.position !== "fixed")) continue;
        const containingBlock = entry.element.offsetParent;
        const containingIndex = path.findIndex((ancestor) => ancestor.element === containingBlock);
        // An intermediate scroller cannot clip a positioned descendant whose
        // containing block is outside it. Keep clipping at that containing
        // block and above; an unknown offset parent grants no exemption.
        if (containingIndex < 0) continue;
        for (let ancestor = containingIndex + 1; ancestor < index; ancestor += 1) {
          const intermediate = path[ancestor];
          if (intermediate !== undefined) outsideContainingBlock.add(intermediate.element);
        }
      }
      for (const entry of path) {
        const style = entry.style;
        if (style.display === "none" || style.visibility !== "visible" ||
          (mutedOnly && Number(style.opacity) === 0) || style.contentVisibility === "hidden") return false;
        // The editor's assistive transcript and list announcements use this
        // clipping pattern. Their one-pixel boxes are not readable pixels.
        if (/^inset\(50%(?:\s+50%)*\)$/.test(style.clipPath.replace(/ /g, ""))) return false;
        if (/^rect\(0px,?\s*0px,?\s*0px,?\s*0px\)$/.test(style.clip)) return false;
        if (entry.element === element || outsideContainingBlock.has(entry.element)) continue;
        const clipped = entry.element.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          left = Math.max(left, clipped.left);
          right = Math.min(right, clipped.right);
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          top = Math.max(top, clipped.top);
          bottom = Math.min(bottom, clipped.bottom);
        }
      }
      return right > left && bottom > top;
    };

    /** Ordered background branches underneath a positioned control. */
    const underControl = (element: Element, path: Layer[], textStyle: CSSStyleDeclaration): BeneathControl[] => {
      let control: Element | null =
        textStyle.position === "absolute" || textStyle.position === "fixed" ? element : null;
      if (control === null) {
        for (const entry of [...path].reverse()) {
          if ((entry.style.position === "absolute" || entry.style.position === "fixed") &&
            entry.element.matches("button, input, textarea, [role='button']")) {
            control = entry.element;
            break;
          }
        }
      }
      if (control === null) return [];
      const box = control.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
      const branches: BeneathControl[] = [];
      for (const beneath of document.elementsFromPoint(x, y)) {
        if (control.contains(beneath) || beneath.contains(control)) continue;
        const branch: Layer[] = [];
        for (let node: Element | null = beneath; node !== null; node = node.parentElement) {
          const at = path.findIndex((entry) => entry.element === node);
          if (at >= 0) {
            branches.push({ at, branch: paints(branch) });
            break;
          }
          branch.unshift(layer(node));
        }
      }
      return branches;
    };

    let muted: string | null = null;
    if (mutedOnly) {
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      document.body.append(probe);
      muted = getComputedStyle(probe).color;
      probe.remove();
    }

    const text: TextPaint[] = [];
    const read = (element: Element, path: Layer[], pseudo = ""): void => {
      const style = pseudo === "" ? getComputedStyle(element) : getComputedStyle(element, pseudo);
      if (style.display === "none" || style.visibility !== "visible" || (mutedOnly && Number(style.opacity) === 0)) return;
      if (muted !== null && style.color !== muted) return;
      text.push({
        where: name(element, pseudo), colour: style.color,
        layers: paints(pseudo === "" ? path : [...path, { element, style }]),
        beneath: underControl(element, path, style),
      });
    };

    for (const element of [start, ...start.querySelectorAll("*")]) {
      const path = pathTo(element);
      if (!visible(element, path)) continue;
      const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const speaks = [...element.childNodes].some((node) =>
        node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      );
      if ((field && element.value.trim() !== "") || speaks) read(element, path);
      if (field && element.value === "" && element.placeholder.trim() !== "") {
        read(element, path, "::placeholder");
      }
      for (const pseudo of ["::before", "::after"]) {
        const content = getComputedStyle(element, pseudo).content;
        if (content === "none" || content === "normal" || content === '""' || content === "''") continue;
        const attribute = /^attr\(([^)]+)\)$/.exec(content);
        if (attribute !== null && !(element.getAttribute(attribute[1] ?? "") ?? "").trim()) continue;
        read(element, path, pseudo);
      }
    }
    const bodyStyle = getComputedStyle(document.body);
    return {
      page: { backgroundColor: bodyStyle.backgroundColor, backgroundImage: bodyStyle.backgroundImage },
      text,
    };
  }, request);
}
