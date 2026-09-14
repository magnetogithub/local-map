import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import metadata from "@/data/countries-2020.json";
import type {Country} from "@/types/country";
import {createInitialWorldStateV2} from "./initial-world-state-v2";
import type {
  SeedV1CapitalFeature,
  SeedV1FeatureCollection,
  SeedV1GeometryFeature,
} from "./seed-v1-to-v2";

const read = <T,>(file: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), file), "utf8")) as T;

describe("10-6~10-19 production v2 seed entrypoint", () => {
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
  }, 30_000);
});
