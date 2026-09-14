import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import metadata from "@/data/countries-2020.json";
import type {Country} from "@/types/country";
import {createInitialWorldStateV2} from "./initial-world-state-v2";
import {auditSeedTopology} from "./seed-topology-audit";
import type {
  SeedV1CapitalFeature,
  SeedV1FeatureCollection,
  SeedV1GeometryFeature,
} from "./seed-v1-to-v2";

const read = <T,>(file: string) => JSON.parse(
  fs.readFileSync(path.join(process.cwd(), file), "utf8"),
) as T;
const seed = () => ({
  metadata: metadata as Country[],
  countryGeometry: read<SeedV1FeatureCollection<SeedV1GeometryFeature>>(
    "public/data/maps/countries-10m.geojson",
  ),
  capitals: read<SeedV1FeatureCollection<SeedV1CapitalFeature>>(
    "public/data/maps/capitals-2020.geojson",
  ),
  seedVersion: "natural-earth-2020-v1",
  policyVersion: "world-policy-v1",
});

describe("10-55 seed topology audit", () => {
  it("builds a deterministic classified topology without duplicates or world-spanning edges", () => {
    const firstState = createInitialWorldStateV2(seed()).worldState;
    const secondState = createInitialWorldStateV2(seed()).worldState;
    const first = auditSeedTopology(firstState.topology, firstState.territoriesById);
    const second = auditSeedTopology(secondState.topology, secondState.territoriesById);
    expect(first).toEqual({
      edgeCount: 7_688,
      internalEdgeCount: 794,
      coastEdgeCount: 6_894,
      duplicateEdgeCount: 0,
      worldSpanningEdgeCount: 0,
      topologyHash: "544f3152d28295f78717853582e061c655ab23082074aaa5ca2f2facdefd2d3c",
    });

    expect(first.edgeCount).toBeGreaterThan(0);
    expect(first.internalEdgeCount).toBeGreaterThan(0);
    expect(first.coastEdgeCount).toBeGreaterThan(0);
    expect(first.duplicateEdgeCount).toBe(0);
    expect(first.worldSpanningEdgeCount).toBe(0);
    expect(first.topologyHash).toBe(second.topologyHash);
  }, 60_000);
});
