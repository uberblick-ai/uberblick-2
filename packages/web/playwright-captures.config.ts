import { defineConfig } from "@playwright/test";
import acceptance from "./playwright.config.js";

export default defineConfig({
  ...acceptance,
  testDir: "./e2e/captures",
  testMatch: "**/*.capture.ts",
  projects: acceptance.projects?.filter(project => project.name === "chromium"),
});
