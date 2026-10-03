/** Focused supported-device proof; the default suite remains Chromium-only. */
import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
  ...base,
  testMatch: "external-link.spec.ts",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-macbook", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit-ipad", use: { ...devices["iPad (gen 7)"] } },
    { name: "webkit-iphone", use: { ...devices["iPhone 13"] } },
  ],
});
