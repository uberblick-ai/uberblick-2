/**
 * Hocuspocus is pinned to exactly 4.6.0, and this is the check that keeps it
 * there.
 *
 * Keeping the dependency is a decision (#394), and the decision is for one
 * version: the hub's auth boundary and its shutdown path read library
 * internals — the seams characterized in `hocuspocus-seams.test.ts` — so a
 * patch bump has to be a reviewed act rather than something a resolver does on
 * a Tuesday. A range specifier is what would make that silent, which is why a
 * range is what fails here.
 *
 * Three packages, two places to state the pin:
 *
 * - `@hocuspocus/server` and `@hocuspocus/provider` are named by workspace
 *   manifests, so they are pinned there — and in the lockfile's `specifier:`
 *   for each, which is what `--frozen-lockfile` compares against.
 * - `@hocuspocus/common` is named by no manifest of ours: both of the others
 *   depend on it as `^4.6.0`. A workspace override in `pnpm-workspace.yaml` is
 *   the only place that range can be pinned.
 *
 * The pin assertions read files rather than resolving modules on purpose: what
 * must not drift is what a fresh `pnpm install` on another machine would
 * resolve, and that lives in the manifests, not in this checkout's
 * `node_modules`.
 *
 * The last describe block is the exception, and it has to be: the patch's
 * shipped content is two independent copies of one rule, and text cannot tell
 * a live patched line from a dead one. A line that names an identifier the
 * bundle it was pasted into does not bind is syntactically fine, passes every
 * assertion above, and throws on the first frame of every document — which is
 * exactly what shipped in the CJS build under #944 and reached review. So that
 * block executes both installed builds instead of reading them.
 */

import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The one version the decision names. */
const PINNED = "4.6.0";
const SERVER_PATCH = `patches/@hocuspocus__server@${PINNED}.patch`;

/** The packages the decision covers. */
const PINNED_PACKAGES = [
  "@hocuspocus/server",
  "@hocuspocus/provider",
  "@hocuspocus/common",
] as const;

function read(path: string): string {
  return readFileSync(`${REPO}${path}`, "utf8");
}

/** Every workspace manifest, plus the root one. */
function manifests(): string[] {
  const packages = readdirSync(`${REPO}packages`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`);
  return ["package.json", ...packages.sort()];
}

describe("@hocuspocus/* is pinned to an exact version", () => {
  it("names no range in any package.json", () => {
    const ranged: string[] = [];

    for (const path of manifests()) {
      const manifest = JSON.parse(read(path)) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith("@hocuspocus/")) continue;
          if (specifier !== PINNED) {
            ranged.push(`${path}: "${name}": "${specifier}"`);
          }
        }
      }
    }

    expect(
      ranged,
      `@hocuspocus/* is pinned to exactly ${PINNED} by decision (#394): the ` +
        "hub reads library internals, so a bump is a reviewed act. Pin the " +
        "specifier and re-characterize the seams before changing the version.",
    ).toEqual([]);
  });

  it("pins @hocuspocus/common, which no manifest names, in the workspace overrides", () => {
    const overrides = read("pnpm-workspace.yaml");

    expect(
      overrides,
      "@hocuspocus/common is a transitive dependency of both server and " +
        `provider, each asking for a range. Override it to ${PINNED}.`,
    ).toMatch(
      new RegExp(`^\\s*['"]?@hocuspocus/common['"]?:\\s*${PINNED}\\s*$`, "m"),
    );
  });

  it("pins the server patch to the exact version and both runtime builds", () => {
    const workspace = read("pnpm-workspace.yaml");
    const lock = read("pnpm-lock.yaml");
    const patch = read(SERVER_PATCH);
    const declaration = `@hocuspocus/server@${PINNED}`;

    expect(workspace).toContain(`"${declaration}": ${SERVER_PATCH}`);
    expect(lock).toMatch(
      new RegExp(
        `^  '${declaration}':\\n    hash: [0-9a-f]{64}\\n    path: ${SERVER_PATCH}$`,
        "m",
      ),
    );

    for (const path of [
      "src/ClientConnection.ts",
      "dist/hocuspocus-server.esm.js",
      "dist/hocuspocus-server.cjs",
    ]) {
      expect(patch).toContain(`diff --git a/${path} b/${path}`);
    }

    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n");
    expect(added).toContain("return this.pendingDocumentCount;");
    expect(added).not.toContain("Object.keys(this.hookPayloads)");
  });

  it("copies the patch into the hub image before its frozen install", () => {
    const dockerfile = read("Dockerfile");
    const patchCopy = dockerfile.indexOf("COPY patches patches");
    const frozenInstall = dockerfile.indexOf("pnpm install --frozen-lockfile");

    expect(patchCopy).toBeGreaterThan(-1);
    expect(patchCopy).toBeLessThan(frozenInstall);
  });

  it("resolves to exactly that version everywhere in the lockfile", () => {
    const lock = read("pnpm-lock.yaml");

    // Every `specifier:` a workspace importer states for a Hocuspocus package.
    const lines = lock.split("\n");
    const specifiers: string[] = [];
    for (const [index, line] of lines.entries()) {
      const named = /^\s+'(@hocuspocus\/[^']+)':\s*$/.exec(line);
      if (named === null) continue;
      const specifier = /^\s+specifier:\s*(.+)$/.exec(lines[index + 1] ?? "");
      if (specifier === null) continue;
      specifiers.push(`${named[1]}: ${specifier[1]}`);
    }

    // pnpm mirrors `pnpm-workspace.yaml`'s overrides into the lockfile's own
    // top-level `overrides:` block, and that copy is half of what
    // `--frozen-lockfile` compares: a range restored there is a range the
    // next install would honour, so it has to fail here by name too.
    const mirrored = /^overrides:\n((?:[ \t]+\S.*\n)+)/m.exec(lock)?.[1] ?? "";
    expect(
      mirrored,
      "the lockfile mirrors the workspace overrides; @hocuspocus/common must " +
        `read exactly ${PINNED} there as well as in pnpm-workspace.yaml.`,
    ).toMatch(
      new RegExp(`^\\s*['"]?@hocuspocus/common['"]?:\\s*${PINNED}\\s*$`, "m"),
    );

    expect(specifiers.length).toBeGreaterThan(0);
    expect(
      specifiers.filter((entry) => !entry.endsWith(`: ${PINNED}`)),
      "the lockfile is what --frozen-lockfile compares against.",
    ).toEqual([]);

    // And no resolution anywhere in the file — direct or transitive — landed
    // on another version.
    const resolved = new Set(
      [...lock.matchAll(/@hocuspocus\/([a-z-]+)@([^'\s(]+)/g)].map(
        (match) => `${match[1]}@${match[2]}`,
      ),
    );
    expect([...resolved].sort()).toEqual(
      PINNED_PACKAGES.map(
        (name) => `${name.replace("@hocuspocus/", "")}@${PINNED}`,
      ).sort(),
    );
  });
});

/**
 * Both runtime builds, executed.
 *
 * `@hocuspocus/server` ships the same `ClientConnection` twice — an ESM bundle
 * and a CJS bundle — and the patch has to edit both by hand, because the
 * package ships no build. Everything in this repository loads the ESM one
 * (every workspace package is `"type": "module"`, and the hub image runs `tsx`
 * on TypeScript sources), so the CJS copy is shipped, never exercised, and a
 * defect in it is invisible to the suites, to CI and to the Docker review.
 *
 * These probes close that gap for the one rule the patch adds: a document is
 * opened by its Auth message, and any other first frame for a document is
 * dropped without taking a pending slot (`src/ClientConnection.ts:605-624`).
 * Each build is loaded by path — `require` for the CJS bundle, `import()` for
 * the ESM one — and driven through `handleMessage`, the library's own entry
 * point for an incoming frame, so what is asserted is the guard's *effect* in
 * the bytes that ship.
 *
 * Loading both bundles in one file loads Yjs twice, and Yjs says so on stderr.
 * It is inert here: these probes never reach a `Y.Doc`, because they stop the
 * connection at the guard.
 */
describe("the patched admission rule is live in both runtime builds", () => {
  /** Resolved through the `require` condition: `dist/hocuspocus-server.cjs`. */
  const CJS_BUILD = createRequire(import.meta.url).resolve(
    "@hocuspocus/server",
  );
  const ESM_BUILD = join(dirname(CJS_BUILD), "hocuspocus-server.esm.js");

  /** `lib0` is the bundles' own encoder, so it resolves from beside them. */
  const encoding = createRequire(CJS_BUILD)("lib0/encoding") as {
    createEncoder: () => object;
    writeVarUint: (encoder: object, value: number) => void;
    writeVarString: (encoder: object, value: string) => void;
    toUint8Array: (encoder: object) => Uint8Array;
  };

  /**
   * What either build exports, as far as a probe needs it. `handleConnection`
   * returns the `ClientConnection`, whose `getPendingDocumentCount()` is the
   * number the ceiling is enforced from — the same handle
   * `hocuspocus-seams.test.ts` reads.
   */
  type ServerBuild = {
    MessageType: { Auth: number; Sync: number };
    Hocuspocus: new (configuration: Record<string, unknown>) => {
      handleConnection: (
        websocket: unknown,
        request: unknown,
      ) => {
        handleMessage: (data: Uint8Array) => void;
        handleClose: () => void;
        getPendingDocumentCount: () => number;
      };
    };
  };

  async function load(path: string): Promise<ServerBuild> {
    return path.endsWith(".cjs")
      ? (createRequire(import.meta.url)(path) as ServerBuild)
      : ((await import(/* @vite-ignore */ pathToFileURL(path).href)) as ServerBuild);
  }

  /** A first frame for `room`, of the given top-level message type. */
  function frame(build: ServerBuild, room: string, type: number): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarString(encoder, room);
    encoding.writeVarUint(encoder, type);
    if (type === build.MessageType.Auth) {
      // `writeAuthentication` (@hocuspocus/common): the Token submessage, then
      // the token itself. The provider's optional version string may follow.
      encoding.writeVarUint(encoder, 0);
      encoding.writeVarString(encoder, "probe-token");
    }
    return encoding.toUint8Array(encoder);
  }

  /**
   * Deliver one first frame to a fresh connection of `build` and report what
   * the guard did with it: the pending slots it took, and any socket close.
   *
   * `onAuthenticate` never settles on purpose. Everything the guard decides is
   * synchronous — the count is incremented before the frame is handed on, and
   * a refusal closes the socket from the same `try` — so the connection is read
   * while it is still frozen at exactly the state the frame produced, with no
   * document loaded and no second observable to disentangle.
   */
  async function deliverFirstFrame(buildPath: string, type: "auth" | "sync") {
    const build = await load(buildPath);
    const closes: { code: number | undefined; reason: string | undefined }[] =
      [];
    const websocket = {
      readyState: 1,
      send() {},
      close(code?: number, reason?: string) {
        closes.push({ code, reason });
        this.readyState = 3;
      },
    };

    const server = new build.Hocuspocus({
      quiet: true,
      onAuthenticate: () => new Promise(() => {}),
    });
    const connection = server.handleConnection(websocket, {
      url: "/",
      headers: {},
    });

    try {
      connection.handleMessage(
        frame(
          build,
          "patched-build-probe",
          type === "auth" ? build.MessageType.Auth : build.MessageType.Sync,
        ),
      );
      return { pending: connection.getPendingDocumentCount(), closes };
    } finally {
      connection.handleClose();
    }
  }

  for (const [label, buildPath] of [
    ["esm", ESM_BUILD],
    ["cjs", CJS_BUILD],
  ] as const) {
    it(`opens a pending document for an Auth first frame (${label} build)`, async () => {
      expect(
        await deliverFirstFrame(buildPath, "auth"),
        `the ${label} build must admit a valid Auth frame. A guard that throws ` +
          "here — an identifier this bundle does not bind is the way that " +
          "happens — is swallowed into the handler's catch, so every document " +
          "on every socket is refused with 4401 Unauthorized instead.",
      ).toEqual({ pending: 1, closes: [] });
    });

    it(`takes no pending slot for a non-Auth first frame (${label} build)`, async () => {
      expect(
        await deliverFirstFrame(buildPath, "sync"),
        `the ${label} build must drop a first frame that is not an Auth ` +
          "message. Opening a pending document for it takes a slot nothing " +
          "can release, because its client has already been refused and sends " +
          "no further token (#944).",
      ).toEqual({ pending: 0, closes: [] });
    });
  }
});
