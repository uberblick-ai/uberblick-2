/** Transport onclose callbacks may synchronously request another close. */
import { afterAll, expect, it, vi } from "vitest";
import { removeTempDirs, startServer, testConfig } from "./helpers.js";

afterAll(removeTempDirs);

it("shares the close promise with a reentrant transport onclose callback", async () => {
  const rig = await startServer(testConfig());
  const destroy = vi.spyOn(rig.instance.replicas, "destroy");
  const storeClose = vi.spyOn(rig.instance.store, "close");
  let reentered: Promise<void> | undefined;
  rig.instance.server.server.onclose = () => {
    reentered = rig.instance.close();
  };
  const closing = rig.instance.close();
  try {
    await closing;
    expect(reentered).toBe(closing);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(storeClose).toHaveBeenCalledTimes(1);
  } finally {
    await rig.close();
  }
});
