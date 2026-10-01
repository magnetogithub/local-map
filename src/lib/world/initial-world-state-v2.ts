import fs from "node:fs";
import path from "node:path";
import metadata from "@/data/countries-2020.json";
import type {Country} from "@/types/country";
import {createSmallCountryMarkerSeeds} from "../projection/country-map-marker-projection";
import {createCountryPanelPresentationEntries} from "../projection/country-panel-projection";
import {
  migrateWorldSeedV1ToV2,
  type MigratedWorldSeedV2,
  type SeedV1CapitalFeature,
  type SeedV1FeatureCollection,
  type SeedV1GeometryFeature,
  type WorldSeedV1ToV2Input,
} from "./seed-v1-to-v2";
import {buildCanonicalTopology} from "./canonical-topology";
import {countryCoreLeafHash} from "./country-core-hash";
import {countryPresentationLeafHash} from "./country-presentation-hash";
import {createIncrementalDomainHashState} from "./incremental-domain-hash";
import {territoryGeometryLeafHash} from "./territory-geometry-hash";
import {territoryOwnershipLeafHash} from "./territory-ownership-hash";
import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {createWorldStateV2, type WorldStateV2} from "./world-state-v2";

const PRODUCTION_SEED_VERSION = "natural-earth-2020-v1";
const PRODUCTION_POLICY_VERSION = "world-policy-v1";
const GEOMETRY_HASH_POLICY = Object.freeze({
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise",
} as const);

export type InitialWorldStateV2Bootstrap = Readonly<{
  schemaVersion: WorldStateV2["schemaVersion"];
  revision: number;
  countryCount: number;
  territoryCount: number;
  topologyEdgeCount: number;
  hashRoots: WorldStateV2["hashRoots"];
}>;

const readSeedJson = <T,>(file: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "data", "maps", file), "utf8")) as T;

const productionSeed = (): WorldSeedV1ToV2Input => {
  return {
    metadata: metadata as Country[],
    countryGeometry: readSeedJson<SeedV1FeatureCollection<SeedV1GeometryFeature>>(
      "countries-10m.geojson",
    ),
    capitals: readSeedJson<SeedV1FeatureCollection<SeedV1CapitalFeature>>(
      "capitals-2020.geojson",
    ),
    seedVersion: PRODUCTION_SEED_VERSION,
    policyVersion: PRODUCTION_POLICY_VERSION,
  };
};

const productionSmallCountryMarkerSeed = () =>
  readSeedJson<Parameters<typeof createSmallCountryMarkerSeeds>[0]>(
    "small-country-points-2020.geojson",
  );

const buildHashRoots = (state: WorldStateV2) =>
  createIncrementalDomainHashState({
    countryCoreHashes: Object.fromEntries(
      Object.entries(state.countriesById).map(([countryId, country]) => [
        countryId,
        countryCoreLeafHash(country),
      ]),
    ),
    countryPresentationHashes: Object.fromEntries(
      Object.entries(state.countriesById).map(([countryId, country]) => [
        countryId,
        countryPresentationLeafHash(country, state.policyVersion),
      ]),
    ),
    territoryGeometryHashes: Object.fromEntries(
      Object.entries(state.territoriesById).map(([territoryId, territory]) => [
        territoryId,
        territoryGeometryLeafHash(territory, GEOMETRY_HASH_POLICY),
      ]),
    ),
    territoryOwnershipHashes: Object.fromEntries(
      Object.entries(state.territoriesById).map(([territoryId, territory]) => [
        territoryId,
        territoryOwnershipLeafHash(territory),
      ]),
    ),
    topologyEdgeHashes: Object.fromEntries(
      Object.entries(state.topology.edgesById).map(([edgeId, edge]) => [
        edgeId,
        topologyEdgeLeafHash(edge),
      ]),
    ),
  }).hashRoots;

/**
 * Builds the canonical production WorldState v2 seed snapshot.
 * Capital data remains an independent module and is not duplicated in WorldState.
 */
export function createInitialWorldStateV2(
  seed: WorldSeedV1ToV2Input,
): MigratedWorldSeedV2 {
  const migrated = migrateWorldSeedV1ToV2(seed);
  const topology = buildCanonicalTopology(migrated.worldState.territoriesById);
  const stateWithTopology = createWorldStateV2({...migrated.worldState, topology});
  const hashRoots = buildHashRoots(stateWithTopology);
  return Object.freeze({
    worldState: createWorldStateV2({...stateWithTopology, hashRoots}),
    countryCapitalsById: migrated.countryCapitalsById,
  });
}

let productionInitialWorldStateV2: MigratedWorldSeedV2 | undefined;

export function createProductionInitialWorldStateV2(): MigratedWorldSeedV2 {
  productionInitialWorldStateV2 ??= createInitialWorldStateV2(productionSeed());
  return productionInitialWorldStateV2;
}

export function createProductionCountryPanelPresentationEntries() {
  return createCountryPanelPresentationEntries(metadata as Country[]);
}

export function createProductionCountryMapColorSeeds(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries((metadata as Country[]).map(({id, mapColor}) => [id, mapColor])));
}

export function createProductionSmallCountryMarkerSeeds() {
  return createSmallCountryMarkerSeeds(productionSmallCountryMarkerSeed());
}

export function createInitialWorldStateV2Bootstrap(
  state: WorldStateV2,
): InitialWorldStateV2Bootstrap {
  return Object.freeze({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    countryCount: state.countryOrder.length,
    territoryCount: state.territoryOrder.length,
    topologyEdgeCount: Object.keys(state.topology.edgesById).length,
    hashRoots: state.hashRoots,
  });
}
