import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.PAX_BUILD_DIST_DIR ? {distDir: process.env.PAX_BUILD_DIST_DIR} : {}),
  // Archived verification fixtures are never production runtime inputs.
  // Keep the approved Prompt 14 evidence and catalog assets available.
  outputFileTracingExcludes: {"/*": ["./reports/prompt15/**/*", "./reports/maintenance/**/*", "./reports/verification/**/*", "./.tmp/**/*"]},
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
  ...(process.env.NODE_ENV !== 'production' && process.env.PAX_OPERATIONAL_SMOKE === '1' ? {
    turbopack: {resolveAlias: {
      '@/lib/simulation/server/production-provider.server': './src/lib/test-only/region-provider.server.ts',
    }},
  } : {}),
};

export default nextConfig;
