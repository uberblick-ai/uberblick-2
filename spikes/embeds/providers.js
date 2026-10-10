// Embed provider registry for the embeds spike. Plain ES module so the harness
// page, the test runner and (later) the editor can share one copy.
//
// A provider turns a pasted link into everything the block frame needs: the
// iframe address Uberblick builds itself, the label, the frame shape and the
// iframe attributes. The CSP frame-src list is derived from the same table, so
// adding a provider is one entry here.

const SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-storage-access-by-user-activation";

function url(raw) {
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function slugTitle(slug) {
  return slug ? decodeURIComponent(slug).replace(/-/g, " ") : "";
}

const figma = {
  id: "figma",
  label: "Figma",
  frameSrc: ["https://embed.figma.com", "https://www.figma.com"],
  sandbox: SANDBOX,
  allow: "fullscreen; clipboard-write",
  referrerPolicy: "no-referrer",
  shape: { height: 480 },
  match(raw, opts = {}) {
    const u = url(raw);
    if (!u || !/^(www\.)?figma\.com$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const theme = opts.theme === "dark" ? "dark" : "light";
    // Community pages are public but are not /design/ links. Two candidate
    // embed forms are tried; the spike records which one renders.
    if (parts[0] === "community" && parts[1] === "file" && parts[2]) {
      const legacy = new URL("https://www.figma.com/embed");
      legacy.searchParams.set("embed_host", "uberblick");
      legacy.searchParams.set("url", u.href);
      return {
        kind: "community file",
        title: slugTitle(parts[3]) || "Community file",
        candidates: [
          `https://embed.figma.com/community/file/${parts[2]}?embed-host=uberblick&theme=${theme}`,
          legacy.href,
        ],
      };
    }
    const kinds = { design: "design", file: "design", proto: "proto", board: "board", slides: "slides", deck: "deck" };
    const kind = kinds[parts[0]];
    const key = parts[1];
    if (!kind || !key) return null;
    const embed = new URL(`https://embed.figma.com/${kind}/${key}`);
    for (const keep of ["node-id", "starting-point-node-id", "version-id"]) {
      const value = u.searchParams.get(keep);
      if (value) embed.searchParams.set(keep, value);
    }
    embed.searchParams.set("embed-host", "uberblick");
    embed.searchParams.set("theme", theme);
    embed.searchParams.set("footer", "false");
    if (kind === "design") embed.searchParams.set("page-selector", "false");
    const nodeLabel = kind === "design" ? (u.searchParams.get("node-id") ? "frame" : "file") : kind;
    return { kind: nodeLabel, title: slugTitle(parts[2]) || "Figma file", candidates: [embed.href] };
  },
};

const youtube = {
  id: "youtube",
  label: "YouTube",
  frameSrc: ["https://www.youtube-nocookie.com"],
  sandbox: SANDBOX + " allow-presentation",
  allow: "fullscreen; picture-in-picture; encrypted-media; clipboard-write",
  // YouTube is known to refuse embeds that send no referrer; the spike
  // compares this default against no-referrer.
  referrerPolicy: "strict-origin-when-cross-origin",
  shape: { aspect: 16 / 9 },
  match(raw) {
    const u = url(raw);
    if (!u) return null;
    let id = null;
    if (/^(www\.|m\.)?youtube\.com$/.test(u.hostname)) {
      if (u.pathname === "/watch") id = u.searchParams.get("v");
      else {
        const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
        if (m) id = m[2];
      }
    } else if (u.hostname === "youtu.be") {
      id = u.pathname.slice(1);
    }
    if (!id || !/^[\w-]{6,}$/.test(id)) return null;
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    const start = u.searchParams.get("t") ?? u.searchParams.get("start");
    if (start && /^\d+s?$/.test(start)) embed.searchParams.set("start", start.replace("s", ""));
    return { kind: "video", title: "YouTube video", candidates: [embed.href] };
  },
};

const loom = {
  id: "loom",
  label: "Loom",
  frameSrc: ["https://www.loom.com"],
  sandbox: SANDBOX,
  allow: "fullscreen; clipboard-write",
  referrerPolicy: "no-referrer",
  shape: { aspect: 16 / 9 },
  match(raw) {
    const u = url(raw);
    if (!u || !/^(www\.)?loom\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(share|embed)\/([0-9a-f]{16,})/);
    if (!m) return null;
    return { kind: "video", title: "Loom video", candidates: [`https://www.loom.com/embed/${m[2]}`] };
  },
};

export const PROVIDERS = [figma, youtube, loom];

/** Resolve a pasted link to { provider, kind, title, candidates } or null. */
export function resolveEmbed(raw, opts) {
  for (const provider of PROVIDERS) {
    const hit = provider.match(raw, opts);
    if (hit) return { provider, ...hit };
  }
  return null;
}

/** The CSP frame-src every provider needs, and nothing else. */
export function frameSrc() {
  return [...new Set(PROVIDERS.flatMap((p) => p.frameSrc))].join(" ");
}
