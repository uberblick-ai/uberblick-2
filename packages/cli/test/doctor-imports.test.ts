import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

it("keeps doctor independent of the hub and browser servers", async () => {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: ["packages/cli/src/doctor.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    treeShaking: false,
  });

  // Loaded inputs expose transitive imports even when none of their code
  // contributes to the output. The hub's config subpath remains allowed.
  const inputs = Object.keys(result.metafile.inputs);
  expect(inputs).toContain("packages/cli/src/doctor.ts");
  expect(inputs).not.toContain("packages/hub/src/index.ts");
  expect(inputs).not.toContain("packages/cli/src/local-browser-server.ts");
  expect(inputs).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/(?:^|\/)@hocuspocus\/server\//),
  ]));
});
