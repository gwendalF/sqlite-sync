import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
  test: {
    restoreMocks: true,
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
        },
      },
      {
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "firefox" }],
          },
        },
      },
    ],
    exclude: ["dist/**", "node_modules/**"],
  },
});
