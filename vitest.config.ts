import {defineConfig} from "vitest/config";
import path from "node:path";
import {fileURLToPath} from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["e2e/**", "node_modules/**", ".tmp/**", "reports/**", "test-results/**", "playwright-report/**", "data/**", "scripts/prompt14-source-gate.test.mjs"],
  },
  resolve: {alias: {"@": path.resolve(projectDirectory, "src"), "server-only": path.resolve(projectDirectory, "node_modules/next/dist/compiled/server-only/empty.js")}},
});
