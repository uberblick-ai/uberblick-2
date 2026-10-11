import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runChild } from "./child.js";
import { resolveConfig, requireBinding } from "./config.js";
import { isInstallPayload } from "./installation.js";
import { rememberWorkspaceBinding } from "./workspace-registry.js";

/**
 * Resolve the source loader from this package, not the caller's directory.
 */
function tsxLoader(): string {
  return import.meta.resolve("tsx");
}

function mcpServerMain(): string {
  return fileURLToPath(
    new URL("./main.ts", import.meta.resolve("@uberblick/mcp-server")),
  );
}

function installedMcpServerMain(): string {
  return fileURLToPath(new URL("./mcp.mjs", import.meta.url));
}

export async function serveCommand(
  argv: string[],
  err: (text: string) => void = (text) => process.stderr.write(text),
): Promise<number> {
  if (argv.length > 0) {
    err(`ub mcp serve: unexpected argument ${JSON.stringify(argv[0])}\n`);
    return 2;
  }

  const resolved = resolveConfig();
  const binding = requireBinding(resolved);
  for (const warning of resolved.warnings) {
    err(`ub: warning: ${warning}\n`);
  }

  let args: string[];
  if (isInstallPayload()) {
    const main = installedMcpServerMain();
    if (!existsSync(main)) {
      err(`ub mcp serve: the installed MCP server is missing at ${main}; reinstall Uberblick\n`);
      return 1;
    }
    args = [main];
  } else {
    args = ["--import", tsxLoader(), mcpServerMain()];
  }

  await rememberWorkspaceBinding(binding);
  // The server takes only environment and stdio; runChild preserves signals and exit status.
  return await runChild(process.execPath, args, resolved.env);
}
