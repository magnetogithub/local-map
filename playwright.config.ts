import { defineConfig,devices } from "@playwright/test";

export default defineConfig({
  testDir:"./e2e",
  fullyParallel:true,
  workers:2,
  webServer:process.env.PLAYWRIGHT_BASE_URL?undefined:{command:"npm.cmd run dev",url:"http://localhost:3000",reuseExistingServer:true,timeout:120_000},
  use:{baseURL:process.env.PLAYWRIGHT_BASE_URL??"http://localhost:3000",...devices["Desktop Chrome"]},
});
