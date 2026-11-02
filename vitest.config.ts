import {defineConfig} from "vitest/config";
import path from "node:path";
import {fileURLToPath} from "node:url";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Large catalog fixtures are disk and memory intensive. Bounding workers
    // prevents unrelated suites from exhausting the shared I/O/cache budget
    // and timing out only when the complete package test command is used.
    maxWorkers: 1,
    fileParallelism: false,
    exclude: ["e2e/**", "node_modules/**", ".tmp/**", "reports/**", "test-results/**", "playwright-report/**", "data/**", "scripts/prompt14-source-gate.test.mjs"],
    projects: [
      {
        extends: true,
        test: {
          name: "node-tools",
          environment: "node",
          setupFiles: [],
          include: ["scripts/**/*.test.{mjs,ts}", "tools/**/*.test.mjs"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          sequence: {groupOrder: 1},
        },
      },
      {
        extends: true,
        test: {
          name: "application",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
          // Catalog bootstrap/cutover checks read the full immutable world
          // fixture. Under the complete two-worker run they can exceed the
          // generic 5s/10s defaults despite passing deterministically.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          sequence: {groupOrder: 2},
        },
      },
    ],
  },
  resolve: {alias: {"@": path.resolve(projectDirectory, "src"), "server-only": path.resolve(projectDirectory, "node_modules/next/dist/compiled/server-only/empty.js")}},
});
