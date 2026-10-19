import { readFileSync } from "node:fs";

interface ReleaseIdentity {
  version: string;
  sourceCommit: string;
  syncProtocolVersion: number;
}

export function readReleaseIdentity(path = "/release/release.json"): ReleaseIdentity | undefined {
  let contents: string;
  try { contents = readFileSync(path, "utf8"); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const release = JSON.parse(contents);
  if (typeof release.version !== "string" || typeof release.sourceCommit !== "string" ||
      !Number.isInteger(release.syncProtocolVersion)) throw new Error("invalid image release identity");
  return release as ReleaseIdentity;
}
