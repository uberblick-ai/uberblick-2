// Serves the harness on 127.0.0.1 with the CSP the embeds block would need.
// `node spikes/embeds/serve.mjs [port]`; `?csp=0` on any page drops the header.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { frameSrc } from "./providers.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png" };

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  `frame-src ${frameSrc()}`,
].join("; ");

export function serve(port = 4599) {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const rel = normalize(u.pathname === "/" ? "/harness.html" : u.pathname).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(dir, rel));
      const headers = { "content-type": types[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" };
      if (u.searchParams.get("csp") !== "0") headers["content-security-policy"] = CSP;
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 4599);
  await serve(port);
  console.log(`Embeds harness on http://127.0.0.1:${port}/  (CSP: ${CSP})`);
}
