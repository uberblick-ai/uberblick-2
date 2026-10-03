/** Host process: filesystem socket only, never opens SQLite or receives tokens. */
import { createConnection } from "node:net";
import { parseWorkspaceId } from "@uberblick/schema";
import { adminSocketPath } from "./admin-setup.js";
import { hubDatabasePath } from "./config.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const status = args.length === 2 && args[0] === "status";
  const id = status ? args[1] : args[0];
  try {
    if (id === undefined || (!status && args.length !== 1) ||
        parseWorkspaceId(id).uuid !== id) throw new Error();
  } catch {
    console.error("usage: hub-admin-setup <workspace-uuid> | status <setup-uuid>");
    process.exitCode = 2;
    return;
  }
  const path = adminSocketPath(hubDatabasePath());
  await new Promise<void>((done) => {
    const socket = createConnection(path);
    let input = "";
    let terminal = false;
    let setupId: string | undefined = status ? id : undefined;
    const unknown = () => {
      if (terminal) return;
      terminal = true;
      console.error(`setup result unknown${setupId === undefined ? "" : `; setup ${setupId}`}. This does not establish that nothing changed. Check its status on the hub host.`);
      process.exitCode = 1;
    };
    const cancel = () => {
      if (terminal) return;
      socket.write(`${JSON.stringify({ action: "cancel" })}\n`);
      socket.setTimeout(2000, () => { unknown(); socket.destroy(); });
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cancel);
    socket.setTimeout(16 * 60_000, () => { unknown(); socket.destroy(); });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(status ? { action: "status", setupId: id } : { action: "start", workspaceId: id })}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > 65_536) { unknown(); socket.destroy(); return; }
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const result = JSON.parse(line);
          if (result.setupId !== undefined) setupId = result.setupId;
          if (result.status === "starting") {
            console.log(`Setup ${setupId}; workspace ${result.workspaceId}`);
          } else if (result.status === "pending") {
            console.log(`Open ${result.verificationUri} on any machine and approve code ${result.userCode} (expires in ${result.expiresIn}s).`);
          } else {
            if (result.status === "complete") {
              if (typeof result.identity?.githubUsername !== "string" ||
                  typeof result.identity?.githubAccountId !== "string" ||
                  typeof result.workspaceId !== "string" || typeof result.hadDocuments !== "boolean") throw new Error();
              console.log(`complete: ${result.identity.githubUsername} (GitHub account ${result.identity.githubAccountId}) is the first admin of workspace ${result.workspaceId}; ${result.hadDocuments ? "adopted existing hub documents" : "hub held no documents for this workspace"}. Setup ${result.setupId}.`);
              terminal = true;
            } else if (result.status === "unknown") {
              unknown();
            } else if (["denied", "expired", "abandoned", "failed", "cancelled", "not-configured",
                "workspace-has-membership", "invalid-request", "busy"].includes(result.status)) {
              console.log(`${result.status}${setupId === undefined ? "" : `: setup ${setupId}`}; no administrator was granted by this setup.`);
              terminal = true;
              process.exitCode = 1;
            } else throw new Error();
            socket.end();
          }
        } catch { unknown(); socket.destroy(); }
      }
    });
    socket.on("error", unknown);
    socket.on("close", () => {
      unknown();
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, cancel);
      done();
    });
  });
}

main().catch(() => {
  console.error("setup result unknown; check the hub host. This does not establish that nothing changed.");
  process.exitCode = 1;
});
