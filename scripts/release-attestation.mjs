import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function verifyReleaseAttestation(subject, workflow, input) {
  try {
    execFileSync("gh", ["attestation", "verify", subject,
      "--repo", "uberblick-ai/uberblick-2",
      "--signer-workflow", `uberblick-ai/uberblick-2/.github/workflows/${workflow}`,
      "--source-ref", `refs/tags/${input.tag}`, "--source-digest", input.headSha,
    ], { stdio: "inherit", timeout: 60_000 });
  } catch (error) {
    throw new Error(`No verified release provenance for ${subject}; use a new version.`, { cause: error });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [workflow, tag, headSha, ...subjects] = process.argv.slice(2);
  if (!workflow || !tag || !headSha || subjects.length === 0) {
    throw new Error("usage: node scripts/release-attestation.mjs WORKFLOW TAG SHA SUBJECT...");
  }
  for (const subject of subjects) verifyReleaseAttestation(subject, workflow, { tag, headSha });
}
