import { defineConfig,devices } from "@playwright/test";

export default defineConfig({
  testDir:"./e2e",
  timeout:300_000,
  fullyParallel:false,
  // MapLibre/WebGL and full-viewport screenshot cases share a constrained Chromium/V8
  // budget on Windows. Keep the canonical suite serial to prevent cross-test GPU/OOM
  // contention while preserving every viewport and integration scenario.
  workers:1,
  use:{baseURL:process.env.PLAYWRIGHT_BASE_URL??"http://localhost:3000",...devices["Desktop Chrome"]},
});
