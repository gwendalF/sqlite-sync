import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  reporter: "list",
  webServer: {
    command: "pnpm exec http-server . -p 4713",
    url: "http://127.0.0.1:4713/tests",
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  use: {
    browserName: "firefox",
    headless: true,
  },
});
