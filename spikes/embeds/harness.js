import { resolveEmbed } from "./providers.js";

const events = (window.__events = []);
const logEl = document.getElementById("log");
function log(caseId, type, detail = "") {
  const entry = { t: Math.round(performance.now()), case: caseId, type, detail };
  events.push(entry);
  logEl.textContent += `${entry.t}ms  ${caseId ?? "-"}  ${type}  ${detail}\n`;
}

document.addEventListener("securitypolicyviolation", (e) =>
  log(null, "csp-violation", `${e.violatedDirective} ${e.blockedURI}`));
document.addEventListener("keydown", (e) => log(null, "parent-keydown", e.key));
window.addEventListener("blur", () => log(null, "window-blur", document.activeElement?.closest?.(".case")?.id ?? ""));

let active = null;
function release() {
  if (!active) return;
  log(active.dataset.case, "released");
  active.classList.remove("active");
  active = null;
}
document.addEventListener("mousedown", (e) => {
  if (active && !active.contains(e.target)) release();
});

let n = 0;
function addCase(parent, { name, raw, theme = "light", variant = "proposed", override = {}, lazy = false, srcIndex = 0, rawSrc = null }) {
  const id = `c${++n}`;
  const section = document.createElement("section");
  section.className = "case";
  section.id = id;
  section.dataset.case = id;
  section.dataset.name = name;
  section.dataset.variant = variant;

  const hit = rawSrc ? null : resolveEmbed(raw, { theme });
  if (!hit && !rawSrc) {
    section.innerHTML = `<div class="refused">${name}: refused, not a supported embed link.<div class="meta">${raw}</div></div>`;
    section.dataset.refused = "true";
    parent.append(section);
    log(id, "refused", raw);
    return;
  }
  const provider = hit?.provider;
  const src = rawSrc ?? hit.candidates[srcIndex];
  section.dataset.src = src;
  section.dataset.provider = provider?.id ?? "none";

  const block = document.createElement("div");
  block.className = "block";
  const cap = document.createElement("div");
  cap.className = "cap";
  cap.innerHTML = `<strong>${provider?.label ?? "Embed"}</strong><span class="title"></span><button type="button" data-done>Done</button><a target="_blank" rel="noopener noreferrer">Open</a>`;
  cap.querySelector(".title").textContent = `${name} · ${hit?.kind ?? ""} · ${variant}`;
  cap.querySelector("a").href = raw ?? src;

  const frame = document.createElement("div");
  frame.className = "frame";
  frame.dataset.case = id;
  const shape = provider?.shape ?? { height: 360 };
  if (shape.aspect) frame.style.aspectRatio = String(shape.aspect);
  else frame.style.height = `${shape.height}px`;

  const iframe = document.createElement("iframe");
  const attrs = {
    sandbox: provider?.sandbox ?? "allow-scripts",
    allow: provider?.allow ?? "",
    referrerpolicy: provider?.referrerPolicy ?? "no-referrer",
    ...override,
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null) continue;
    iframe.setAttribute(k, v);
  }
  iframe.setAttribute("title", `${provider?.label ?? "Embed"}: ${name}`);
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("loading", lazy ? "lazy" : "eager");
  let loads = 0;
  iframe.addEventListener("load", () => log(id, "iframe-load", String(++loads)));
  iframe.src = src;

  const shield = document.createElement("button");
  shield.type = "button";
  shield.className = "shield";
  shield.setAttribute("aria-label", `Interact with ${name}`);
  shield.innerHTML = "<span>Click to interact</span>";
  shield.addEventListener("click", () => {
    release();
    frame.classList.add("active");
    active = frame;
    log(id, "activated");
    iframe.focus();
  });
  cap.querySelector("[data-done]").addEventListener("click", release);

  frame.append(iframe, shield);
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${src}\nsandbox=${attrs.sandbox ?? "(none)"} referrer=${attrs.referrerpolicy}`;
  block.append(cap, frame);
  section.append(block, meta);
  parent.append(section);
}

const { samples } = await (await fetch("samples.json")).json();
const root = document.getElementById("cases");
const usable = samples.filter((s) => s.url);
let firstFigma = null;
let firstLazy = null;
for (const s of usable) {
  const hit = resolveEmbed(s.url);
  if (!hit) { addCase(root, { name: s.name, raw: s.url }); continue; }
  hit.candidates.forEach((_, i) =>
    addCase(root, { name: s.name, raw: s.url, srcIndex: i, variant: hit.candidates.length > 1 ? `proposed, candidate ${i + 1}` : "proposed" }));
  if (hit.provider.id === "figma" && !s.name.includes("broken") && hit.kind !== "community file") firstFigma ??= s;
  if (hit.provider.id === "youtube") {
    addCase(root, { name: s.name, raw: s.url, variant: "no-referrer", override: { referrerpolicy: "no-referrer" } });
  }
  if (!firstLazy && !s.name.includes("broken")) firstLazy = s;
}
const figmaVariantSource = firstFigma ?? usable.find((s) => resolveEmbed(s.url)?.provider.id === "figma" && !s.name.includes("broken"));
if (figmaVariantSource) {
  addCase(root, { name: figmaVariantSource.name, raw: figmaVariantSource.url, variant: "no sandbox", override: { sandbox: null } });
  addCase(root, { name: figmaVariantSource.name, raw: figmaVariantSource.url, variant: "dark theme", theme: "dark" });
}
// CSP negative: a frame source that is not on the allowlist must be blocked.
addCase(root, { name: "Off-allowlist frame", rawSrc: "https://example.com/", variant: "must be blocked by CSP" });
if (firstLazy) addCase(document.getElementById("lazy-slot"), { name: firstLazy.name, raw: firstLazy.url, variant: "lazy", lazy: true });
log(null, "ready", String(n));
window.__ready = true;
