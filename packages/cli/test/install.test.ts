/**
 * What `ub mcp install` promises.
 *
 * It edits no configuration file. Claude Code and Codex are wired up by running
 * their own `mcp add`; every other client gets a snippet and the path to paste
 * it into. So the contracts under test are the ones that are left: the right
 * delegation — the right program, the right arguments, the right configuration
 * directory — an entry somebody else wrote is never replaced and never quoted
 * back, a second run is a no-op, and no credential of this machine's ever
 * reaches a stream. Nothing here prompts: every one of these runs with no
 * terminal attached, which is the point of the flags.
 *
 * The vendor CLIs are stubbed rather than invoked. What `ub` owes is the right
 * delegation, and asserting that against a real `claude` would make the suite
 * depend on the machine it runs on.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_ENTRY, snippet } from "../src/mcp-config.js";
import {
  REPO_ROOT,
  type Sandbox,
  UB_BIN,
  removeTempDirs,
  runUb,
  sandbox,
} from "./helpers.js";

afterAll(removeTempDirs);

/** A PATH with nothing on it, so every vendor CLI lookup fails with ENOENT. */
const NO_VENDOR = { PATH: "/nonexistent-for-tests" };

/** Where a stub records the arguments it was called with. */
const RECORD = "UB_TEST_VENDOR_RECORD";

/**
 * The variables a stub reports on — and it reports presence only, never a
 * value. A vendor child inherits nearly the whole environment, so a stub that
 * dumped it would write this machine's real secrets into a temp file merely to
 * prove that six of them are absent. `RECORD` leads the list as the positive
 * control: it is always set, so a recording of nothing but `absent` cannot
 * pass for an answer.
 */
const REPORTED = [
  RECORD,
  "HUB_AUTH_TOKEN",
  "HUB_URL",
  "HUB_DB_PATH",
  "UBERBLICK_DB",
  "WORKSPACE_ID",
  "WORKSPACES",
  "CODEX_HOME",
];

/**
 * A value that must never reach a terminal. Config files are where people keep
 * tokens, and every path that reports on one has to be safe for that.
 */
const SECRET = "tok-must-never-be-printed-4a1f";

const WORKSPACE = "4d8e2f11-6a73-4c95-8b20-9e1f5c3a7d64";

interface Stub {
  /** Prepend to PATH, and the environment that points the stub at its record. */
  env: NodeJS.ProcessEnv;
  /** The arguments the stub was called with, one per line. */
  record: string;
  /** `CODEX_HOME` as the stub saw it. */
  home: string;
  /** `NAME=present` or `NAME=absent`, one line per reported variable. */
  environment: string;
}

function stubVendor(box: Sandbox, program: string, body = ""): Stub {
  const dir = join(box.cwd, "..", `stub-${program}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, program);
  const record = join(dir, "record");
  // One `${NAME+present}` per reported variable rather than a dump of the
  // environment: sh has no indirect expansion, and nothing here may write a
  // value anyway. PATH is the stub's own directory alone, so only builtins run.
  const report = REPORTED.map(
    (name) =>
      `seen=\${${name}+present}\nprintf '${name}=%s\\n' "\${seen:-absent}"`,
  ).join("\n");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$${RECORD}"\n` +
      `printf '%s\\n' "$CODEX_HOME" > "$${RECORD}.home"\n` +
      `{\n${report}\n} > "$${RECORD}.env"\n${body}`,
    "utf8",
  );
  chmodSync(path, 0o755);
  return {
    env: { PATH: dir, [RECORD]: record },
    record,
    home: `${record}.home`,
    environment: `${record}.env`,
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** A Codex configuration directory of this sandbox's own, never the machine's. */
function codexHome(box: Sandbox, at = join(box.cwd, "codex-home")): string {
  mkdirSync(at, { recursive: true });
  return at;
}

describe("ub mcp install --print", () => {
  it("prints a snippet for the named target and touches no file", () => {
    const box = sandbox();

    const claude = runUb(["mcp", "install", "claude", "--project", "--print"], box);
    expect(claude.status).toBe(0);
    expect(JSON.parse(claude.stdout).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(claude.stderr).toContain(join(box.cwd, ".mcp.json"));
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Codex's file is TOML, so the snippet has to be TOML — a JSON snippet
    // would be a valid-looking answer that silently does not work.
    const codex = runUb(["mcp", "install", "codex", "--user", "--print"], box, {
      CODEX_HOME: codexHome(box),
    });
    expect(codex.status).toBe(0);
    expect(codex.stdout).toBe(
      '[mcp_servers.uberblick]\ncommand = "ub"\nargs = ["mcp", "serve"]\n',
    );
  });

  it("answers for a client it does not know, and writes nothing", () => {
    // `--print` is the documented answer for any client not on the list, so it
    // has to work *without* a known target rather than rejecting the name.
    const box = sandbox();
    const run = runUb(["mcp", "install", "zed", "--print"], box);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(run.stderr).toMatch(/not a client/);
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("names the targets, and points an unlisted client at --print", () => {
    const run = runUb(["mcp", "install", "emacs"], sandbox());
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/claude, codex, cursor/);
    expect(run.stderr).toMatch(/--print/);
  });
});

describe("ub mcp install, and the vendor's own CLI", () => {
  /**
   * The exact delegation, per target and scope.
   *
   * Written out rather than generated: these argument lists are the vendors'
   * documented syntax as their installed CLIs actually take it — including the
   * environment flag a `--workspace` pin rides on, which is the whole reason
   * this command no longer writes the pin itself.
   */
  const CELLS: {
    what: string;
    program: string;
    argv: string[];
    expected: string[];
  }[] = [
    {
      what: "claude, project, unpinned",
      program: "claude",
      argv: ["mcp", "install", "claude", "--project"],
      expected: [
        "mcp",
        "add",
        "uberblick",
        "--scope",
        "project",
        "--",
        "ub",
        "mcp",
        "serve",
      ],
    },
    {
      what: "claude, user, pinned",
      program: "claude",
      argv: ["mcp", "install", "claude", "--user", "--workspace", WORKSPACE],
      expected: [
        "mcp",
        "add",
        "uberblick",
        "--scope",
        "user",
        "-e",
        `WORKSPACE_ID=${WORKSPACE}`,
        "--",
        "ub",
        "mcp",
        "serve",
      ],
    },
    {
      what: "codex, user, unpinned",
      program: "codex",
      argv: ["mcp", "install", "codex", "--user"],
      expected: ["mcp", "add", "uberblick", "--", "ub", "mcp", "serve"],
    },
    {
      what: "codex, project, pinned",
      program: "codex",
      argv: ["mcp", "install", "codex", "--project", "--workspace", WORKSPACE],
      expected: [
        "mcp",
        "add",
        "uberblick",
        "--env",
        `WORKSPACE_ID=${WORKSPACE}`,
        "--",
        "ub",
        "mcp",
        "serve",
      ],
    },
  ];

  it.each(CELLS)("delegates $what", ({ program, argv, expected }) => {
    const box = sandbox();
    const stub = stubVendor(box, program);
    const run = runUb(argv, box, { ...stub.env, CODEX_HOME: codexHome(box) });

    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`via\\s+${program} mcp add`));
    expect(read(stub.record).trimEnd().split("\n")).toEqual(expected);
    // The vendor writes the file; `ub` must not also write one behind its back.
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);
  });

  it("points codex at the configuration directory the scope means", () => {
    // `codex mcp add` has no scope flag: which file it writes *is* CODEX_HOME,
    // so project scope has to hand it the checkout's own directory — the same
    // one this command then reports and probes.
    const box = sandbox();
    const stub = stubVendor(box, "codex");
    const run = runUb(["mcp", "install", "codex", "--project"], box, {
      ...stub.env,
      CODEX_HOME: codexHome(box),
    });

    expect(run.status, run.output).toBe(0);
    expect(realpathSync(read(stub.home).trim())).toBe(
      realpathSync(join(box.cwd, ".codex")),
    );
    expect(run.stdout).toContain(join(".codex", "config.toml"));
  });

  it("says what a pinned entry costs, in the report the vendor's run produced", () => {
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    const run = runUb(
      ["mcp", "install", "claude", "--project", "--workspace", WORKSPACE, "--label", "ablauf"],
      box,
      stub.env,
    );

    expect(run.status, run.output).toBe(0);
    expect(read(stub.record)).toContain("uberblick-ablauf");
    expect(run.stdout).toContain(`This entry is pinned to ${WORKSPACE}`);
    expect(run.stdout).toContain("does not follow `ub workspace use`");
  });

  it("reports that it failed without repeating what it said", () => {
    // A client's own diagnostics quote the config it just read, so relaying
    // them would walk straight past everything this command refuses to print.
    const box = sandbox();
    const stub = stubVendor(
      box,
      "claude",
      `echo "conflict in config: API_TOKEN=${SECRET}" >&2\necho "${SECRET}"\nexit 1\n`,
    );

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.output).not.toContain(SECRET);
    // Enough to act on: which program, how it ended, and where to look.
    expect(run.stderr).toMatch(/claude mcp add/);
    expect(run.stderr).toMatch(/exited 1/);
  });

  it("hands the vendor no variable of uberblick's own", () => {
    // `ub` is habitually run with a signing secret and an endpoint exported —
    // that is exactly what `fnox exec` does — and a child inherits whatever it
    // is handed. A vendor CLI has no use for either, and a client that records
    // its environment would be keeping this machine's credential in its own
    // format. The pin a vendor does need rides in argv, not here.
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    const ours: NodeJS.ProcessEnv = {
      HUB_AUTH_TOKEN: SECRET,
      HUB_URL: "wss://hub.example.ts.net",
      HUB_DB_PATH: "/tmp/hub.sqlite",
      UBERBLICK_DB: "/tmp/uberblick.sqlite",
      WORKSPACE_ID: WORKSPACE,
      WORKSPACES: "one,two",
    };

    const run = runUb(["mcp", "install", "claude", "--project"], box, {
      ...stub.env,
      ...ours,
    });

    expect(run.status, run.output).toBe(0);
    // The stub reports presence, not values, so this file is safe to write on
    // a real machine. `RECORD` is the positive control: it is always set, so
    // the absences below are about what was stripped, not about an empty
    // recording.
    const received = read(stub.environment);
    expect(received).toMatch(new RegExp(`^${RECORD}=present$`, "m"));
    for (const name of Object.keys(ours)) {
      expect(received, name).toMatch(new RegExp(`^${name}=absent$`, "m"));
    }
    expect(received).not.toContain(SECRET);
  });

  it("prints the snippet when the vendor is not installed, and leaves nothing behind", () => {
    const box = sandbox();

    const claude = runUb(["mcp", "install", "claude", "--project"], box, NO_VENDOR);
    expect(claude.status).toBe(0);
    expect(claude.stderr).toMatch(/`claude` is not installed/);
    expect(JSON.parse(claude.stdout).mcpServers.uberblick.command).toBe("ub");
    expect(existsSync(join(box.cwd, ".mcp.json"))).toBe(false);

    // Codex refuses a CODEX_HOME that is not there, so project scope creates
    // one — and a run that ended in a snippet must not leave it in a checkout.
    const codex = runUb(["mcp", "install", "codex", "--project"], box, NO_VENDOR);
    expect(codex.status).toBe(0);
    expect(codex.stdout).toContain("[mcp_servers.uberblick]");
    expect(existsSync(join(box.cwd, ".codex"))).toBe(false);
  });

  it("leaves a `.codex` it did not create, empty or not", () => {
    // "Writes nothing" has to include taking nothing away. An empty `.codex` a
    // checkout already had is still somebody's state — and whether this run is
    // the one that made the directory is the only thing that decides it.
    const box = sandbox();
    const dir = join(box.cwd, ".codex");
    mkdirSync(dir, { recursive: true });

    const run = runUb(["mcp", "install", "codex", "--project"], box, NO_VENDOR);
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toContain("[mcp_servers.uberblick]");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("ub mcp install, and what is registered already", () => {
  it("reports what the vendor's own CLI wrote as already installed, and runs nothing", () => {
    // `claude mcp add` writes `type` and an empty `env`, and the snippet writes
    // neither. Equality is about what the client will run, so this must not be
    // a clash between two ways of installing the very same server.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      {
        mcpServers: {
          uberblick: { type: "stdio", command: "ub", args: ["mcp", "serve"], env: {} },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(run.stdout).toMatch(/^client\s+claude \(project\)$/m);
    expect(read(path)).toBe(before);
    // Not "it exited 0": the vendor was never asked, so a duplicate add cannot
    // fail and a foreign entry cannot be clobbered by one.
    expect(existsSync(stub.record)).toBe(false);
  });

  it("recognises the pinned table `codex mcp add` writes", () => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before =
      'model = "gpt-5"\n\n[mcp_servers.uberblick]\ncommand = "ub"\n' +
      `args = ["mcp", "serve"]\n\n[mcp_servers.uberblick.env]\nWORKSPACE_ID = "${WORKSPACE}"\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = runUb(
      ["mcp", "install", "codex", "--user", "--workspace", WORKSPACE],
      box,
      { ...stub.env, CODEX_HOME: home },
    );
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toMatch(/already installed/);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("refuses a `[mcp_servers.uberblick]` that is spelled another way", () => {
    // A quoted key, spaces inside the brackets and a trailing comment are one
    // table spelled four ways, and reading any of them as "nothing there" would
    // run `codex mcp add` — whose duplicate add exits 0 and replaces what it
    // finds. A header this cannot compare byte for byte is somebody else's.
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    const before =
      '[ mcp_servers."uberblick" ] # theirs\ncommand = "somebody-elses"\n' +
      `args = ["serve"]\n\n[mcp_servers."uberblick".env]\nAPI_TOKEN = "${SECRET}"\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...stub.env,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("somebody-elses");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  /**
   * The same entry, written without the header the scan looks for. TOML spells
   * one key several ways, and each of these defines `mcp_servers.uberblick` —
   * so reading any of them as "nothing there" would point `codex mcp add` at
   * somebody's entry and let its duplicate add replace it.
   */
  const UNHEADED = [
    {
      what: "an inline table under `[mcp_servers]`",
      before:
        '[mcp_servers]\nuberblick = { command = "somebody-elses", args = ["serve"], ' +
        `env = { API_TOKEN = "${SECRET}" } }\n`,
    },
    {
      what: "dotted keys at the root",
      before:
        'model = "gpt-5"\nmcp_servers.uberblick.command = "somebody-elses"\n' +
        `mcp_servers.uberblick.args = ["serve"]\nmcp_servers.uberblick.env.API_TOKEN = "${SECRET}"\n`,
    },
    {
      what: "a bare `env` sub-table",
      before: `[mcp_servers.uberblick.env]\nAPI_TOKEN = "${SECRET}"\n`,
    },
  ];

  it.each(UNHEADED)("refuses $what", ({ before }) => {
    const box = sandbox();
    const home = codexHome(box);
    const path = join(home, "config.toml");
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "codex");

    const run = runUb(["mcp", "install", "codex", "--user"], box, {
      ...stub.env,
      CODEX_HOME: home,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(run.output).not.toContain(SECRET);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("refuses an entry it did not write, prints the snippet, and quotes nothing", () => {
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      {
        mcpServers: {
          other: { command: "other-server" },
          uberblick: {
            command: "somebody-elses",
            args: ["serve"],
            env: { API_TOKEN: SECRET },
          },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(
      /already registers "uberblick" as something other than this/,
    );
    // The way out is the snippet, and nothing out of their file comes with it:
    // not the command it runs, and certainly not what it sets.
    expect(JSON.parse(run.stdout).mcpServers.uberblick.command).toBe("ub");
    expect(run.output).not.toContain(SECRET);
    expect(run.output).not.toContain("somebody-elses");
    // Byte-identical afterwards, and the vendor was never given the chance.
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("refuses a target file it cannot read, rather than delegating over it", () => {
    // Reading this as "absent" would mean "go ahead" — and going ahead points
    // `claude mcp add` at a file this could not read, which it loads and
    // rewrites. Nothing of it comes back out, not even a parser's complaint.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `{ "mcpServers": { "uberblick": { "token": "${SECRET}"\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toMatch(/could not be read/);
    expect(run.output).not.toContain(SECRET);
    // The way out is the same snippet, and the file is untouched.
    expect(JSON.parse(run.stdout).mcpServers.uberblick.command).toBe("ub");
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });

  it("does not call an entry ours when its `env` is not an environment", () => {
    // `null`, `[]`, `""`, a number: all of them have no entries to compare, and
    // an entry whose environment this cannot read is not one it understands.
    const box = sandbox();
    const path = join(box.cwd, ".mcp.json");
    const before = `${JSON.stringify(
      {
        mcpServers: {
          uberblick: { command: "ub", args: ["mcp", "serve"], env: null },
        },
      },
      null,
      2,
    )}\n`;
    writeFileSync(path, before, "utf8");
    const stub = stubVendor(box, "claude");

    const run = runUb(["mcp", "install", "claude", "--project"], box, stub.env);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/something other than this/);
    expect(read(path)).toBe(before);
    expect(existsSync(stub.record)).toBe(false);
  });
});

describe("ub mcp install cursor", () => {
  it("prints the snippet and the file to paste it into, and writes nothing", () => {
    // Cursor ships no `mcp add`, so there is nothing to delegate to — and a
    // client `ub` cannot drive is told about rather than written to.
    const box = sandbox();
    const run = runUb(["mcp", "install", "cursor", "--project"], box);

    expect(run.status).toBe(0);
    expect(run.stderr).toContain(join(box.cwd, ".cursor", "mcp.json"));
    expect(JSON.parse(run.stdout).mcpServers.uberblick).toEqual({
      type: "stdio",
      command: "ub",
      args: ["mcp", "serve"],
    });
    expect(existsSync(join(box.cwd, ".cursor"))).toBe(false);
  });
});

describe("the checkout's own .mcp.json", () => {
  /**
   * The spawn the committed file has to carry, stated here independently.
   *
   * This is the whole point of the test: with the expectation written out, the
   * committed file and the generator are each checked against *it*, so changing
   * either one alone fails. Reading the arguments out of the file and feeding
   * them back in would only ever prove the generator agrees with itself.
   */
  const CHECKOUT_SPAWN = ["ub", "mcp", "serve"];

  it("is what this command prints, rather than hand-maintained", () => {
    // The same line every other client gets, and for the same reason: `ub mcp
    // serve` resolves workspace, endpoint and credential itself, so this file
    // never needs an override or a wrapper to carry them.
    const committed = read(join(REPO_ROOT, ".mcp.json"));
    const entry = JSON.parse(committed).mcpServers.uberblick;
    expect([entry.command, ...entry.args]).toEqual(CHECKOUT_SPAWN);

    // Byte for byte, which is what "generated rather than hand-maintained"
    // actually means: a file somebody edited by hand would differ in its
    // spacing long before it differed in what it registers. Against the snippet
    // now, because `claude mcp add` writes bytes of its own — so running
    // `ub mcp install claude --project` in this checkout must never be what
    // keeps this file current.
    expect(committed).toBe(snippet("json", DEFAULT_ENTRY));
  });

  it("carries no workspace pin, so this checkout follows the machine default", () => {
    // A project entry MAY pin `WORKSPACE_ID` — that is how a repository binds
    // itself to a workspace now — and this one deliberately does not, so
    // `ub workspace use` still moves what an agent session here reads.
    const entry = JSON.parse(read(join(REPO_ROOT, ".mcp.json"))).mcpServers
      .uberblick;
    expect(entry.env).toBeUndefined();
  });
});

describe("ub mcp install --workspace", () => {
  const OTHER = "4d8e0000-1111-4222-8333-444455556666";

  /** A `<uuid>.sqlite` in the data directory: a workspace with a local replica. */
  function withDatabase(box: Sandbox, uuid: string): void {
    const dir = join(box.dataHome, "uberblick");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.sqlite`), "", "utf8");
  }

  it("never prints an endpoint, a credential or a secret, in any format", () => {
    // A client config is committable, and `credentials.json` is the one file on
    // this machine that must not be copied anywhere. Nothing is written now, so
    // the surface to scan is the snippet and the report around it — every
    // target format, pinned and unpinned. `WORKSPACE_ID` is deliberately not on
    // the list: it is an id, it is the one value an entry may carry, and the
    // pinned runs below print it on purpose.
    const forbidden = [
      SECRET,
      "wss://hub.example.ts.net",
      "HUB_URL",
      "HUB_AUTH_TOKEN",
      "HUB_CREDENTIAL",
      "HUB_ROOT_SECRET",
      "signingSecret",
    ];

    for (const target of ["claude", "cursor", "codex"] as const) {
      for (const pin of [[], ["--workspace", WORKSPACE]]) {
        const box = sandbox({
          userConfig: { workspace: WORKSPACE, hubUrl: "wss://hub.example.ts.net" },
          credentials: { signingSecret: SECRET },
        });
        const run = runUb(["mcp", "install", target, "--project", ...pin], box, {
          ...NO_VENDOR,
          CODEX_HOME: codexHome(box),
        });
        expect(run.status, run.output).toBe(0);
        for (const value of forbidden) {
          expect(run.output, `${target} ${pin.join(" ")}`).not.toContain(value);
        }
        expect(run.stdout).toContain(pin.length === 0 ? "uberblick" : WORKSPACE);
      }
    }
  });

  it("refuses an unusable id with `ub workspace use`'s own messages, and runs nothing", () => {
    const box = sandbox();
    const stub = stubVendor(box, "claude");
    withDatabase(box, WORKSPACE);
    withDatabase(box, OTHER);

    const install = (...flags: string[]) =>
      runUb(["mcp", "install", "claude", "--project", ...flags], box, stub.env);

    // Ambiguous: both `4d8e…` uuids start with it, and the refusal names them.
    const ambiguous = install("--workspace", "4d8e");
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toMatch(WORKSPACE);
    expect(ambiguous.stderr).toMatch(OTHER);

    const noMatch = install("--workspace", "ffff");
    expect(noMatch.status).toBe(2);
    expect(noMatch.stderr).toMatch(/no workspace on this machine starts with/);

    const notAUuid = install("--workspace", "my-notes");
    expect(notAUuid.status).toBe(2);
    expect(notAUuid.stderr).toMatch(/is not a workspace id/);

    // A name with nothing to pin would be a second entry running the same
    // unpinned command under a second name, which is not a thing to install.
    const unpinned = install("--label", "ablauf");
    expect(unpinned.status).toBe(2);
    expect(unpinned.stderr).toMatch(/needs a --workspace/);

    const stale = install("--workspace", WORKSPACE, "--name", "ablauf");
    expect(stale.status).toBe(2);
    expect(stale.stderr).toMatch(/Unknown option '--name'/);

    expect(existsSync(stub.record)).toBe(false);
  });
});

describe("two entries, side by side", () => {
  const PRIMARY = "1e9b7a30-52c4-4d6f-8a13-c7b204e5f981";
  const PINNED = "8f21c604-3b7d-4a15-9c62-0d5e8b3f7a29";

  /** The environment a spawn wants: strings only, no undefined values. */
  function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  interface Registered {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }

  /** A session spawned exactly as the entry `ub` printed says to spawn it. */
  async function open(entry: Registered, box: Sandbox): Promise<Client> {
    const client = new Client({ name: "uberblick-install-tests", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: box.cwd,
        env: stringEnv({ ...box.env, ...entry.env }),
      }),
    );
    return client;
  }

  /** One tool call, as the JSON the tool answered with. */
  async function call<T>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return JSON.parse((content[0] as { text: string }).text) as T;
  }

  interface Listing {
    workspace: string;
    docs: { title: string }[];
  }

  it("serve disjoint corpora out of one data directory", async () => {
    const box = sandbox({ userConfig: { workspace: PRIMARY } });
    // Both entries have to spawn *this* checkout's `ub`, which is not on any
    // PATH, so both are printed through the `--` override. Everything else —
    // the names, the pin, the shape — is what `ub mcp install` decided.
    const spawnLine = [process.execPath, UB_BIN, "mcp", "serve"];
    const primaryRun = runUb(
      ["mcp", "install", "claude", "--print", "--", ...spawnLine],
      box,
    );
    const pinnedRun = runUb(
      [
        "mcp",
        "install",
        "claude",
        "--print",
        "--workspace",
        PINNED,
        "--label",
        "other",
        "--",
        ...spawnLine,
      ],
      box,
    );
    expect(primaryRun.status, primaryRun.output).toBe(0);
    expect(pinnedRun.status, pinnedRun.output).toBe(0);

    const primary = await open(
      JSON.parse(primaryRun.stdout).mcpServers.uberblick,
      box,
    );
    const pinned = await open(
      JSON.parse(pinnedRun.stdout).mcpServers["uberblick-other"],
      box,
    );
    try {
      const description = "A test document.";
      await call(primary, "create_doc", {
        title: "only in the primary",
        description,
      });
      await call(pinned, "create_doc", {
        title: "only in the pinned one",
        description,
      });

      const here = await call<Listing>(primary, "list_docs", {});
      const there = await call<Listing>(pinned, "list_docs", {});

      // Two workspaces, two corpora: the pinned entry ignores the workspace the
      // directory configures, and neither can see the other's document.
      expect(here.workspace).toBe(PRIMARY);
      expect(there.workspace).toBe(PINNED);
      expect(here.docs.map((doc) => doc.title)).toEqual(["only in the primary"]);
      expect(there.docs.map((doc) => doc.title)).toEqual(["only in the pinned one"]);
    } finally {
      await primary.close();
      await pinned.close();
    }
  });
});
