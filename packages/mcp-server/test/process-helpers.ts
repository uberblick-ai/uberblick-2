import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const HUB_ROOT = resolve(PACKAGE_ROOT, "../hub");

/** Every child executes one prebuilt entry directly, so SIGKILL ends its work. */
export function builtSource(source: string): string {
  return join(PACKAGE_ROOT, ".test-build", `${relative(resolve(PACKAGE_ROOT, "../.."), source).replaceAll(/[\\/]/g, "-").replace(/\.ts$/, "")}.mjs`);
}

export function builtWorker(name: string): string {
  return builtSource(join(PACKAGE_ROOT, "test", `${name}-worker.ts`));
}

export function mainProcess(): { command: string; args: string[] } {
  return { command: process.execPath, args: [builtSource(join(PACKAGE_ROOT, "src/main.ts"))] };
}

/** Derive both preload and entry from the package's real checkout invocation. */
export function hubCheckoutInvocation(): { args: string[]; sources: string[] } {
  const manifest = JSON.parse(readFileSync(join(HUB_ROOT, "package.json"), "utf8")) as { scripts: { start: string } };
  const [command, ...original] = manifest.scripts.start.split(" ");
  if (command !== "node") throw new Error("hub start must invoke node directly");
  const args: string[] = [];
  const sources: string[] = [];
  let tsxLoaded = false;
  for (let index = 0; index < original.length; index += 1) {
    const arg = original[index]!;
    // The loader's work is performed once by global setup instead of per child.
    if (arg === "--import" && original[index + 1] === "tsx") { tsxLoaded = true; index += 1; continue; }
    if (arg.endsWith(".ts")) {
      if (!tsxLoaded) throw new Error("hub start must load --import tsx before TypeScript sources");
      const source = resolve(HUB_ROOT, arg);
      sources.push(source);
      args.push(builtSource(source));
    } else args.push(arg);
  }
  return { args, sources };
}
