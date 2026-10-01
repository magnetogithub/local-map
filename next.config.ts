import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.PAX_E2E_BUILD === "1" ? {
    distDir: ".next-e2e",
    env: {NEXT_PUBLIC_PAX_E2E: "1"},
    cacheMaxMemorySize: 0,
    turbopack: {
      resolveAlias: {
        "@/lib/map/scenario-debug-bridge": "./src/lib/test-only/map-scenario-debug-bridge.ts",
      },
    },
  } : {}),
};

export default nextConfig;
