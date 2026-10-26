import { expect, it, vi } from "vitest";
import type { CredentialProvider } from "../src/credential-provider.js";
import { openWorkspaceReplicas } from "../src/workspace-replicas.js";
import { testConfig } from "./core-helpers.js";

it("refuses hub-free credential composition before checking a grant", () => {
  const config = testConfig();
  const provider: CredentialProvider = {
    read: vi.fn(() => { throw new Error("A hub-free workspace must not read credentials."); }),
    ensure: vi.fn(async () => { throw new Error("A hub-free workspace must not renew credentials."); }),
  };
  expect(() => openWorkspaceReplicas(config, { hubFree: true, credentialProvider: provider }))
    .toThrow("A hub-free workspace cannot use a credential provider.");
  expect(provider.read).not.toHaveBeenCalled();
  expect(provider.ensure).not.toHaveBeenCalled();
});
