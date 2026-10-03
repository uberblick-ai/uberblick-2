import type { Page } from "@playwright/test";

export interface TextReading {
  where: string;
  colour: string;
  ground: string;
  ratio: number;
  /** CSS opacity on the text and its ancestors, independent of colour alpha. */
  opacity: number;
}

/**
 * Read enabled text from a rendered surface, including generated labels and
 * field placeholders. Both pixels pass through each opacity group: dimming a
 * card changes its backing pixel as well as its text. A positioned control can
 * be painted over a sibling, as the terminal controls are, so its hit stack is
 * consulted before falling back to its ancestors' backgrounds.
 */
export function renderedText(
  page: Page,
  root: string,
  options: { mutedOnly?: boolean } = {},
): Promise<TextReading[]> {
  return readPaint(page, { selector: root, mutedOnly: options.mutedOnly ?? false }) as Promise<TextReading[]>;
}

/** The visible OKLab step of a neutral stroke, after its colour alpha. */
export function strokeSeparation(page: Page, ink: string, ground: string): Promise<number> {
  return readPaint(page, { selector: "", mutedOnly: false, stroke: { ink, ground } }) as Promise<number>;
}

function readPaint(
  page: Page,
  request: { selector: string; mutedOnly: boolean; stroke?: { ink: string; ground: string } },
): Promise<TextReading[] | number> {
  return page.evaluate(({ selector, mutedOnly, stroke }) => {
    type Pixel = [number, number, number];
    type Colour = { pixel: Pixel; alpha: number; lab?: Pixel };
    type Layer = { element: Element; style: CSSStyleDeclaration };

    const clamp = (value: number): number => Math.min(1, Math.max(0, value));
    const number = (value: string, percent = 1): number => {
      if (value === "none") return 0;
      return value.endsWith("%")
        ? Number.parseFloat(value) * percent / 100
        : Number(value);
    };
    const encode = (linear: number): number => {
      const channel = clamp(linear);
      return channel <= 0.0031308
        ? 12.92 * channel
        : 1.055 * channel ** (1 / 2.4) - 0.055;
    };
    // Computed CSS colours stay in OKLab/OKLCH in Chromium. Converting their
    // resolved channels directly retains precision at the 4.5:1 boundary;
    // Canvas' ordinary ImageData would quantize them to eight bits first.
    const colour = (painted: string): Colour => {
      const match = /^(rgb|rgba|oklch|oklab|color)\((.*)\)$/.exec(painted.trim());
      if (match === null) throw new Error(`unreadable rendered colour: ${painted}`);
      const model = match[1];
      const body = match[2] ?? "";
      const [channels = "", rawAlpha] = body.split("/");
      const parts = channels.trim().split(/[\s,]+/);
      let alpha = rawAlpha === undefined ? 1 : number(rawAlpha.trim());
      if (model === "rgb" || model === "rgba") {
        if (parts.length === 4) alpha = number(parts[3] ?? "1");
        const rgb = parts.slice(0, 3).map((part) =>
          clamp(part.endsWith("%") ? number(part) : Number(part) / 255),
        );
        return { pixel: [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0], alpha };
      }
      if (model === "color") {
        const space = parts.shift();
        if (space !== "srgb" && space !== "srgb-linear") {
          throw new Error(`unsupported rendered colour space: ${painted}`);
        }
        const rgb = parts.map((part) => {
          const channel = number(part);
          return space === "srgb-linear" ? encode(channel) : clamp(channel);
        });
        return { pixel: [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0], alpha };
      }
      const lightness = number(parts[0] ?? "0");
      let a = number(parts[1] ?? "0", 0.4);
      let b = number(parts[2] ?? "0", 0.4);
      if (model === "oklch") {
        const hue = parts[2] ?? "0";
        let degrees = Number.parseFloat(hue);
        if (hue === "none") degrees = 0;
        else if (hue.endsWith("turn")) degrees *= 360;
        else if (hue.endsWith("grad")) degrees *= 0.9;
        else if (hue.endsWith("rad")) degrees *= 180 / Math.PI;
        const radians = degrees * Math.PI / 180;
        b = a * Math.sin(radians);
        a *= Math.cos(radians);
      }
      const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return {
        pixel: [
          encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
        ],
        alpha,
        lab: [lightness, a, b],
      };
    };
    const blend = (over: Pixel, under: Pixel, alpha: number): Pixel => [
      over[0] * alpha + under[0] * (1 - alpha),
      over[1] * alpha + under[1] * (1 - alpha),
      over[2] * alpha + under[2] * (1 - alpha),
    ];
    if (stroke !== undefined) {
      const over = colour(stroke.ink);
      const under = colour(stroke.ground);
      if (under.alpha !== 1) throw new Error("cannot establish a translucent stroke ground");
      const lab = (pixel: Pixel): Pixel => {
        const [r = 0, g = 0, b = 0] = pixel.map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        );
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [
          0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        ];
      };
      const one = over.alpha === 1 && over.lab !== undefined
        ? over.lab : lab(blend(over.pixel, under.pixel, over.alpha));
      const two = under.lab ?? lab(under.pixel);
      return Math.hypot(one[0] - two[0], one[1] - two[1], one[2] - two[2]);
    }
    const start = document.querySelector(selector);
    if (start === null) throw new Error(`no rendered text surface for ${selector}`);
    const luminance = (pixel: Pixel): number => {
      const channels = pixel.map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * (channels[0] ?? 0) +
        0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
    };
    const ratio = (ink: Pixel, ground: Pixel): number => {
      const one = luminance(ink) + 0.05;
      const two = luminance(ground) + 0.05;
      return Math.max(one, two) / Math.min(one, two);
    };
    const serialized = (pixel: Pixel): string =>
      `rgb(${pixel.map((channel) => (channel * 255).toFixed(6)).join(", ")})`;
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

    const bodyStyle = getComputedStyle(document.body);
    const stops = bodyStyle.backgroundImage === "none"
      ? [bodyStyle.backgroundColor]
      : bodyStyle.backgroundImage.match(/(?:rgba?|oklch|oklab|color)\([^)]*\)/g);
    if (stops === null || stops.length === 0) throw new Error("no readable page ground");
    const pageGrounds = stops.map((stop) => {
      const resolved = colour(stop);
      if (resolved.alpha !== 1) throw new Error("cannot establish a translucent page ground");
      return resolved.pixel;
    });
    if (bodyStyle.backgroundImage !== "none" &&
      !/^(?:radial|linear)-gradient\(/.test(bodyStyle.backgroundImage)) {
      throw new Error("cannot establish the ground through a painted image");
    }
    const background = (entry: Layer, under: Pixel, pageGround: Pixel): Pixel => {
      if (entry.style.backgroundImage !== "none") {
        if (entry.element !== document.body) {
          throw new Error("cannot establish the ground through a painted image");
        }
        return pageGround;
      }
      const fill = colour(entry.style.backgroundColor);
      return blend(fill.pixel, under, fill.alpha);
    };
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
      for (const entry of path) {
        const style = entry.style;
        if (style.display === "none" || style.visibility !== "visible" ||
          (mutedOnly && Number(style.opacity) === 0) || style.contentVisibility === "hidden") return false;
        // The editor's assistive transcript and list announcements use this
        // clipping pattern. Their one-pixel boxes are not readable pixels.
        if (/^inset\(50%(?:\s+50%)*\)$/.test(style.clipPath.replace(/ /g, ""))) return false;
        if (/^rect\(0px,?\s*0px,?\s*0px,?\s*0px\)$/.test(style.clip)) return false;
        if (entry.element === element) continue;
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

    /** A background branch underneath a positioned control, before its common ancestor. */
    const underControl = (element: Element, path: Layer[], textStyle: CSSStyleDeclaration): {
      at: number;
      branch: Layer[];
    } | null => {
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
      if (control === null) return null;
      const box = control.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
      const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
      for (const beneath of document.elementsFromPoint(x, y)) {
        if (control.contains(beneath) || beneath.contains(control)) continue;
        const branch: Layer[] = [];
        for (let node: Element | null = beneath; node !== null; node = node.parentElement) {
          const at = path.findIndex((entry) => entry.element === node);
          if (at >= 0) {
            if (branch.some((entry) => entry.style.backgroundImage !== "none" ||
              colour(entry.style.backgroundColor).alpha > 0)) return { at, branch };
            break;
          }
          branch.unshift(layer(node));
        }
      }
      return null;
    };

    let muted: string | null = null;
    if (mutedOnly) {
      const probe = document.createElement("span");
      probe.style.color = "var(--muted-foreground)";
      document.body.append(probe);
      muted = getComputedStyle(probe).color;
      probe.remove();
    }

    const readings: TextReading[] = [];
    const read = (element: Element, path: Layer[], pseudo = ""): void => {
      const style = pseudo === "" ? getComputedStyle(element) : getComputedStyle(element, pseudo);
      if (style.display === "none" || style.visibility !== "visible" || (mutedOnly && Number(style.opacity) === 0)) return;
      if (muted !== null && style.color !== muted) return;
      const text = colour(style.color);
      const layers = pseudo === "" ? path : [...path, { element, style }];
      const beneath = underControl(element, path, style);
      const opacity = layers.reduce((product, entry) => product * Number(entry.style.opacity), 1);
      const painted = (pageGround: Pixel, withText: boolean): Pixel => {
        const paintBranch = (branch: Layer[], index: number, backing: Pixel): Pixel => {
          const entry = branch[index];
          if (entry === undefined) return backing;
          const local = background(entry, backing, pageGround);
          return blend(paintBranch(branch, index + 1, local), backing, Number(entry.style.opacity));
        };
        const paint = (index: number, backing: Pixel): Pixel => {
          const entry = layers[index];
          if (entry === undefined) return withText ? blend(text.pixel, backing, text.alpha) : backing;
          let local = background(entry, backing, pageGround);
          if (beneath !== null && index === beneath.at) {
            local = paintBranch(beneath.branch, 0, local);
          }
          return blend(paint(index + 1, local), backing, Number(entry.style.opacity));
        };
        return paint(0, pageGround);
      };
      const seen = new Set<string>();
      for (const pageGround of pageGrounds) {
        const ground = painted(pageGround, false);
        const ink = painted(pageGround, true);
        const serializedGround = serialized(ground);
        if (seen.has(serializedGround)) continue;
        seen.add(serializedGround);
        readings.push({
          where: name(element, pseudo), colour: style.color, ground: serializedGround,
          ratio: ratio(ink, ground), opacity,
        });
      }
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
    return readings;
  }, request);
}
