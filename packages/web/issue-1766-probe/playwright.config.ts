import actual from "../playwright.config.ts";

export default {
  testDir: ".",
  testMatch: "trace.spec.ts",
  outputDir: "../test-results",
  workers: 1,
  retries: actual.retries,
  use: actual.use,
  timeout: 20_000,
  projects: actual.projects?.filter((project) => project.name !== "chromium-workload"),
};
