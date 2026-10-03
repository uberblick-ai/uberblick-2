import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the publication scan refuses forbidden files in any layer, even a later deletion", () => {
  const scratch = mkdtempSync(join(tmpdir(), `image-scan-${process.env.UB_AGENTS_RUN ?? "test"}-`));
  const fixture = `import io, json, sys, tarfile
def layer(path):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w') as t:
  m=tarfile.TarInfo(path); m.size=1; t.addfile(m,io.BytesIO(b'x'))
 return b.getvalue()
with tarfile.open(sys.argv[1],'w') as t:
 for name,data in [('manifest.json',json.dumps([{'Layers':['one.tar','two.tar']}]).encode()),('one.tar',layer(sys.argv[2])),('two.tar',layer('.wh.'+sys.argv[2]))]:
  m=tarfile.TarInfo(name); m.size=len(data); t.addfile(m,io.BytesIO(data))
`;
  try {
    for (const path of [".env", "app/.env.local", "nested/fnox.toml", "nested/mise.local.toml",
      "data/hub.sqlite", "data/hub.sqlite-journal", "fixtures/test.db", "app/packages/hub/src/main.ts",
      "release/remote.env.example", "app/hub.mjs"]) {
      const archive = join(scratch, "fixture.tar");
      const create = spawnSync("python3", ["-c", fixture, archive, path], { encoding: "utf8" });
      assert.equal(create.status, 0, create.stderr);
      const scan = spawnSync("python3", ["scripts/check-hub-image.py", archive], { encoding: "utf8" });
      const permitted = ["release/remote.env.example", "app/hub.mjs"].includes(path);
      assert.equal(scan.status === 0, permitted, `${path}: ${scan.stderr}`);
    }
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
});
