import {defineConfig} from "vitest/config";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const files: string[] = JSON.parse(process.env.PROMPT15_TEST_FILES ?? "[]");
if (!files.length || files.some(file => typeof file !== "string" || /[*?{}\[\]!]/.test(file))) {
  throw new Error("Prompt 15 requires explicit test files through run-vitest-checks.mjs");
}
let testDirectory = path.dirname(path.resolve(root, files[0]));
const directories = new Map<string, string[]>();
for (const file of files) {
  const absolute = path.resolve(root, file);
  const directory = path.dirname(absolute);
  directories.set(directory, [...(directories.get(directory) ?? []), path.basename(absolute)]);
  while (!absolute.startsWith(testDirectory + path.sep)) testDirectory = path.dirname(testDirectory);
}

export default defineConfig({
  root,
  cacheDir: path.join(process.env.PROMPT15_TEST_OUTPUT ?? root, "cache"),
  resolve: {alias: {"@": path.join(root, "src"), "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js")}},
  test: {
    environment: "node", dir: testDirectory,
    include: files.map(file => path.relative(testDirectory, path.resolve(root, file)).replaceAll("\\", "/")), exclude: [],
    projects: directories.size > 1 ? [...directories].map(([dir, include], index) => ({
      extends: true,
      test: {name: `explicit-directory-${index}`, dir, include, exclude: []},
    })) : undefined,
    reporters: [path.join(root, "scripts/prompt15-orchestrator/compact-vitest-reporter.mjs")],
    silent: true, maxWorkers: 2, fileParallelism: false,
    passWithNoTests: false, testTimeout: 30_000, hookTimeout: 30_000,
  },
});
