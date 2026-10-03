/** Focused editor touch proof; the full browser suite keeps its existing matrix. */
import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.js";

export default defineConfig({
  ...base,
  testMatch: "touch-editor.spec.ts",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-ipad", use: { ...devices["iPad (gen 7)"], browserName: "chromium" } },
    { name: "webkit-macbook", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "webkit-ipad", use: { ...devices["iPad (gen 7)"] } },
    { name: "webkit-iphone", use: { ...devices["iPhone 13"] } },
  ],
});
