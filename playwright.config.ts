import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser-fixtures",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  reporter: "line",
  use: {
    headless: true,
  },
});
