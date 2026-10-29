import type { NextConfig } from "next";
import currentOperationalCatalog from './data/runtime/operational-catalog/current.json';

const seedCatalogVersion = "catalog-v1-73e30c25c9637d6376cb65afa82483c6";

const nextConfig: NextConfig = {
  ...(process.env.PAX_BUILD_DIST_DIR ? {distDir: process.env.PAX_BUILD_DIST_DIR} : {}),
  // Dynamic checked reads are not inferred by tracing. Pin only the current runtime inputs.
  outputFileTracingIncludes: {"/*": [
    "data/runtime/operational-catalog/current.json",
    `${currentOperationalCatalog.root}/**/*`,
    "data/source-locks/prompt14-derived-game-input-lock.json",
    "data/raw/ne_10m_admin_1_states_provinces.geojson",
    "data/catalogs/prompt14/frozen-catalog-ref.json",
    ...["artifact-index", "migration-pair"].map(file => `data/catalogs/prompt14/${seedCatalogVersion}/${file}.json`),
    ...["catalog", "topology"].map(file => `data/catalogs/prompt14/${seedCatalogVersion}/build-only/${seedCatalogVersion}/${file}.json`),
    `data/catalog-consumers/prompt14/${seedCatalogVersion}/consumer-approval.json`,
    `public/data/territory-catalog/${seedCatalogVersion}/**/*`,
    "reports/prompt14/14-08-immutable-catalog-checkpoint.json",
  ]},
  // Keep the approved Prompt 14 inputs, but omit archived and orchestration state.
  outputFileTracingExcludes: {"/*": ["./reports/prompt15/**/*", "./reports/maintenance/**/*", "./reports/verification/**/*", "./.tmp/**/*", "./scripts/prompt15-orchestrator/**/*"]},
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
