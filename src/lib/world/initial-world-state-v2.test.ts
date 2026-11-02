import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import metadata from "@/data/countries-2020.json";
import type {Country} from "@/types/country";
import {
  createInitialWorldStateV2,
  createInitialWorldStateV2Bootstrap,
  createProductionInitialWorldStateV2,
  createProductionCountryMapColorSeeds,
} from "./initial-world-state-v2";
import type {
  SeedV1CapitalFeature,
  SeedV1FeatureCollection,
  SeedV1GeometryFeature,
} from "./seed-v1-to-v2";

const read = <T,>(file: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), file), "utf8")) as T;

describe("10-6~10-19 production v2 seed entrypoint", () => {
  it("passes the original country colors to the runtime map", () => {
    const colors = createProductionCountryMapColorSeeds();
    expect(colors.CHN).toBe("#88494a");
    expect(colors.RUS).toBe("#3b5e4d");
    expect(colors.FRA).toBe("#7895c4");
    expect(Object.keys(colors)).toHaveLength(247);
  });

  it("returns only the canonical v2 state and independent capital module", () => {
    const result = createInitialWorldStateV2({
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

    expect(Object.keys(result).sort()).toEqual(["countryCapitalsById", "worldState"]);
    expect(result.worldState.schemaVersion).toBe(2);
    expect(result.worldState.countryOrder).toHaveLength(247);
    expect(result.worldState.territoryOrder).toHaveLength(247);
    expect(Object.keys(result.countryCapitalsById)).toHaveLength(196);
    expect("legacyWorldState" in result).toBe(false);
  }, 120_000);

  it("exposes the production runtime initial WorldStateV2 entrypoint with ownership, topology, and hash roots", () => {
    const {worldState} = createProductionInitialWorldStateV2();
    const activeCountryIds = new Set(worldState.countryOrder);
    const hashRootPattern = /^[a-f0-9]{64}$/;

    expect(worldState.schemaVersion).toBe(2);
    expect(worldState.revision).toBe(0);
    expect(worldState.countryOrder).toHaveLength(247);
    expect(worldState.territoryOrder).toHaveLength(247);
    expect(Object.keys(worldState.topology.edgesById).length).toBeGreaterThan(0);
    expect(worldState.hashRoots.countriesRootHash).toMatch(hashRootPattern);
    expect(worldState.hashRoots.presentationRootHash).toMatch(hashRootPattern);
    expect(worldState.hashRoots.territoriesRootHash).toMatch(hashRootPattern);
    expect(worldState.hashRoots.topologyRootHash).toMatch(hashRootPattern);

    for (const territory of Object.values(worldState.territoriesById)) {
      if (territory.ownerCountryId === null) {
        throw new Error(`Seed territory has no owner: ${territory.id}`);
      }
      expect(activeCountryIds.has(territory.ownerCountryId)).toBe(true);
    }

    expect(createInitialWorldStateV2Bootstrap(worldState)).toEqual({
      schemaVersion: 2,
      revision: 0,
      countryCount: 247,
      territoryCount: 247,
      topologyEdgeCount: Object.keys(worldState.topology.edgesById).length,
      hashRoots: worldState.hashRoots,
    });
    expect(createProductionInitialWorldStateV2().worldState).toBe(worldState);
  }, 180_000);
});
