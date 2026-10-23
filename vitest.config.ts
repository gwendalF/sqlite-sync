import { defineConfig } from "vitest/config";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
  test: {
    exclude: ["dist/**", "node_modules/**"],
  },
});
