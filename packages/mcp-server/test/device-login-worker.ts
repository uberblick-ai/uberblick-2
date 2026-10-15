import { ensureDeviceLogin, readDeviceLogin } from "../src/device-login.js";

const endpoint = process.argv[2]!;
const workspace = process.argv[3]!;
const before = readDeviceLogin(endpoint, workspace);
process.once("message", async () => {
  try {
    const result = await ensureDeviceLogin(endpoint, workspace, {
      ...(process.argv[4] === "true" && before.status === "ready" ? { rejected: before.login } : {}),
    });
    process.send?.({ status: result.status, id: result.status === "ready" ? result.login.credential.record.id : null });
    process.disconnect?.();
  } catch { process.exitCode = 1; process.disconnect?.(); }
});
process.send?.("ready");
