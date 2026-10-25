export function revisionSurface(surface: { kind?: string; name?: string }, role: "author" | "namer"): string {
  if (surface.kind === "browser") return role === "author" ? "written by hand 👏" : "in the browser";
  const reported = surface.name || surface.kind;
  if (reported === undefined) return "";
  const identity = `${surface.name ?? ""} ${surface.kind ?? ""}`;
  const name = /claude/i.test(identity) ? "Claude" : /codex/i.test(identity) ? "Codex" : reported;
  return `via ${name}`;
}
