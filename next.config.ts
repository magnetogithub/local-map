import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.PAX_E2E_BUILD === "1" ? {
    distDir: process.env.PAX_REVIEW_G_E2E === "1" ? ".next-e2e-review-g" : ".next-e2e",
    env: {NEXT_PUBLIC_PAX_E2E: "1"},
    cacheMaxMemorySize: 0,
    turbopack: {
      resolveAlias: {
        "@/lib/map/scenario-debug-bridge": "./src/lib/test-only/map-scenario-debug-bridge.ts",
        "@/lib/world/regression-page.server": "./src/lib/test-only/regression-page.server.tsx",
        "@/lib/simulation/server/production-provider.server": "./src/lib/test-only/region-provider.server.ts",
      },
    },
  } : {}),
};

export default nextConfig;
