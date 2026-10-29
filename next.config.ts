import type { NextConfig } from "next";

const seedCatalogVersion = "catalog-v1-73e30c25c9637d6376cb65afa82483c6";
const operationalCatalog = "data/derived/prompt15/15-19-operational-catalog-v3-ae59d85d8dedbafc44f6";
const operationalIndices = "data/derived/prompt15/15-20-topology-membership-v1-22406931e1665b6ede05";
const operationalDelivery = "data/derived/prompt15/15-21-world-delivery-v1-56fc6c79c216e6bd1a11";

const nextConfig: NextConfig = {
  ...(process.env.PAX_BUILD_DIST_DIR ? {distDir: process.env.PAX_BUILD_DIST_DIR} : {}),
  // Dynamic checked reads are not inferred by tracing. Pin only the current runtime inputs.
  outputFileTracingIncludes: {"/*": [
    "data/runtime/operational-catalog/catalog-v3-56fc6c79c216e6bd1a11/final-admission.json",
    "data/runtime/operational-catalog/catalog-v3-56fc6c79c216e6bd1a11/verdict.json",
    "data/runtime/operational-catalog/catalog-v3-56fc6c79c216e6bd1a11/delivery-artifact-index.json",
    ...["artifact-index", "catalog-root", "provenance"].map(file => `${operationalCatalog}/${file}.json`),
    `${operationalCatalog}/countries/*/catalog.json.gz`,
    ...["artifact-index", "index-root"].map(file => `${operationalIndices}/${file}.json`),
    ...["adjacency", "administrative-membership", "previous-parent-index"].map(file => `${operationalIndices}/${file}.json.gz`),
    `${operationalIndices}/topology/*.json.gz`,
    ...["provenance", "manifest", "tile-index", "detail-index"].map(file => `${operationalDelivery}/${file}.json`),
    `${operationalDelivery}/lod-coverage.json.gz`,
    `${operationalDelivery}/metadata/**/*`,
    `${operationalDelivery}/detail/**/*`,
    `${operationalDelivery}/tiles/**/*`,
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
