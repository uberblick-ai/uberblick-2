import mermaid from "mermaid";

let serial: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** Configuration and temporary layout share Mermaid's global state. */
export function renderMermaid(text: string, dark: boolean): Promise<string> {
  const render = serial.then(async () => {
    // Mermaid replaces oversized input with a drawn error. Report its limit
    // as a failure instead of presenting that substitution as the diagram.
    if (text.length > 50_000) throw new Error("Mermaid source exceeds the renderer's 50,000 character limit");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      theme: dark ? "dark" : "default",
      fontFamily: "Inter, sans-serif",
      secure: [
        "secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges",
        "suppressErrorRendering", "dompurifyConfig", "themeCSS", "theme",
        "themeVariables", "fontFamily", "altFontFamily", "htmlLabels",
      ],
    });
    // Mermaid's renderers find SVGs through document selectors. Keep their
    // temporary layout outside the editor and remove it even on failure.
    const stage = document.createElement("div");
    stage.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none";
    document.body.append(stage);
    try {
      const result = await mermaid.render(`ub-mermaid-${++nextId}`, text, stage);
      return result.svg;
    } finally {
      stage.remove();
    }
  });
  serial = render.catch(() => undefined);
  return render;
}
