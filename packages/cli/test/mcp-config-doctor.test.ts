import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { claudeDoctorEntries, DEFAULT_ENTRY, doctorEntry, snippet, type TargetFile } from "../src/mcp-config.js";
import { removeTempDirs, sandbox } from "./helpers.js";

afterAll(removeTempDirs);

function config(text: string, format: TargetFile["format"]): TargetFile {
  const file = { path: join(sandbox().cwd, `mcp.${format}`), format };
  writeFileSync(file.path, text);
  return file;
}

describe("doctor's MCP config reads", () => {
  it("reads only binding variables, without judging command or other entry settings", () => {
    const file = config(JSON.stringify({ mcpServers: { uberblick: {
      command: "mise", args: ["exec", "--", "ub", "mcp", "serve"], otherSetting: true,
      env: { UB_WORKSPACE_ID: "workspace", UB_HUB_URL: "local", API_TOKEN: "SECRET", unrelated: 1 },
    } } }), "json");
    expect(doctorEntry(file)).toEqual({
      status: "entry", env: { UB_WORKSPACE_ID: "workspace", UB_HUB_URL: "local" },
    });
    expect(doctorEntry(config('{"mcpServers":{"uberblick":{"url":"custom"}}}', "json")))
      .toEqual({ status: "entry", env: {} });
  });

  it("keeps local and user entries separate in Claude's shared config file", () => {
    const root = "/repository";
    const file = config(JSON.stringify({
      mcpServers: { uberblick: { env: { UB_WORKSPACE_ID: "user" } } },
      projects: {
        [root]: { mcpServers: { uberblick: { env: { UB_WORKSPACE_ID: "local" } } } },
        "/other": { mcpServers: { uberblick: { env: { UB_WORKSPACE_ID: "other" } } } },
      },
    }), "json");
    expect(claudeDoctorEntries(file, root)).toEqual({
      local: { status: "entry", env: { UB_WORKSPACE_ID: "local" } },
      user: { status: "entry", env: { UB_WORKSPACE_ID: "user" } },
    });
    expect(claudeDoctorEntries(file, "/missing").local).toEqual({ status: "absent" });
  });

  it("distinguishes absent entries from files or environments it cannot read", () => {
    expect(doctorEntry(config('{"mcpServers":{"another":{}}}', "json")))
      .toEqual({ status: "absent" });
    const absent = { path: join(sandbox().cwd, "missing.json"), format: "json" } as const;
    expect(doctorEntry(absent)).toEqual({ status: "absent" });
    mkdirSync(absent.path);
    expect(doctorEntry(absent)).toEqual({ status: "unusable" });
    for (const text of ["SECRET", "[]", '{"mcpServers":{"uberblick":null}}',
      '{"mcpServers":{"uberblick":{"env":[]}}}',
      '{"mcpServers":{"uberblick":{"env":{"UB_WORKSPACE_ID":1}}}}']) {
      expect(doctorEntry(config(text, "json"))).toEqual({ status: "unusable" });
    }
    expect(claudeDoctorEntries(config("SECRET", "json"), "/repository"))
      .toEqual({ local: { status: "unusable" }, user: { status: "unusable" } });
  });

  it("reads Codex's env table even when separated from its server table", () => {
    const file = config('[ mcp_servers."uberblick" ] # client config\ncommand = "custom"\n' +
      '[other]\nenabled = true\n[mcp_servers.uberblick.env]\n' +
      '"UB_\\u0057ORKSPACE_ID" = "workspace" # binding\nUB_HUB_URL = \'local\'\n' +
      'WORKSPACE_ID = "legacy"\nHUB_URL = "legacy-hub"\nAPI_TOKEN = "SECRET"\n', "toml");
    expect(doctorEntry(file)).toEqual({ status: "entry", env: {
      UB_WORKSPACE_ID: "workspace", UB_HUB_URL: "local", WORKSPACE_ID: "legacy", HUB_URL: "legacy-hub",
    } });
    expect(doctorEntry(config('[mcp_servers.uberblick]\ncommand = "custom"\nenv = {}\n', "toml")))
      .toEqual({ status: "entry", env: {} });
  });

  it("reads the current install entry beside unrelated multiline settings", () => {
    const text = snippet("toml", DEFAULT_ENTRY) +
      '[other]\ninstructions = """\nUnrelated multiline setting.\n"""\n' +
      'large_integer = 9007199254740993\n';
    expect(doctorEntry(config(text, "toml"))).toEqual({ status: "entry", env: {} });
  });

  it.each([
    {
      layout: "inline env",
      text: '[mcp_servers.uberblick]\ncommand = "custom"\n' +
        'env = { UB_WORKSPACE_ID = "workspace", UB_HUB_URL = "local", API_TOKEN = "SECRET", unrelated = 1 }\n',
    },
    {
      layout: "dotted env keys",
      text: '[mcp_servers.uberblick]\ncommand = "custom"\n' +
        'env.UB_WORKSPACE_ID = "workspace"\nenv.UB_HUB_URL = "local"\n',
    },
    {
      layout: "an inline server",
      text: '[mcp_servers]\nuberblick = { command = "custom", ' +
        'env = { UB_WORKSPACE_ID = "workspace", UB_HUB_URL = "local" } }\n',
    },
    {
      layout: "a dotted server",
      text: 'mcp_servers.uberblick.command = "custom"\n' +
        'mcp_servers.uberblick.env.UB_WORKSPACE_ID = "workspace"\n' +
        'mcp_servers.uberblick.env.UB_HUB_URL = "local"\n',
    },
    {
      layout: "an implicit server table",
      text: '[mcp_servers.uberblick.env]\nUB_WORKSPACE_ID = "workspace"\nUB_HUB_URL = "local"\n',
    },
    {
      layout: "multiline and wide-Unicode string pins",
      text: '[mcp_servers.uberblick.env]\n' +
        'UB_WORKSPACE_ID = """workspace"""\nUB_HUB_URL = "\\U0000006cocal"\n',
    },
  ])("reads Codex's pins from $layout", ({ text }) => {
    expect(doctorEntry(config(text, "toml"))).toEqual({
      status: "entry", env: { UB_WORKSPACE_ID: "workspace", UB_HUB_URL: "local" },
    });
  });

  it("keeps an apparent pin inside an unrelated multiline string out of the entry", () => {
    const text = '[mcp_servers.uberblick]\ncommand = "custom"\n' +
      '[other]\ninstructions = """\n[mcp_servers.uberblick.env]\n' +
      'UB_WORKSPACE_ID = "concealed"\n"""\n';
    expect(doctorEntry(config(text, "toml"))).toEqual({ status: "entry", env: {} });
  });

  it("never treats malformed Codex config or unreadable pins as unpinned", () => {
    const server = '[mcp_servers.uberblick]\ncommand = "custom"\n';
    for (const text of [
      'mcp_servers = "SECRET"\n',
      '[mcp_servers]\nuberblick = "SECRET"\n',
      `${server}env = ["SECRET"]\n`,
      'mcp_servers = 1979-05-27\n',
      '[mcp_servers]\nuberblick = 1979-05-27\n',
      `${server}env = 1979-05-27\n`,
      `${server}[mcp_servers.uberblick.env]\nUB_WORKSPACE_ID = 1\n`,
      `${server}[mcp_servers.uberblick.env]\nUB_WORKSPACE_ID = "first"\nUB_WORKSPACE_ID = "second"\n`,
      `${server}[mcp_servers.uberblick]\ncommand = "second"\n`,
      '[mcp_servers.uberblick]\ncommand = "unterminated SECRET\n',
      `${server}unparseable SECRET\n`,
    ]) expect(doctorEntry(config(text, "toml"))).toEqual({ status: "unusable" });
    expect(doctorEntry(config('[mcp_servers.other]\ncommand = "custom"\n', "toml")))
      .toEqual({ status: "absent" });
  });
});
