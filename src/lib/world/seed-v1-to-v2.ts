import type {Country} from "@/types/country";

import {
  createCountryEntity,
  type CountryEntity,
  type CountryPoliticalStatus,
} from "./country-entity";
import {createCountryIdRegistry, type ActiveCountryId} from "./country-id";
import {createCountryOrder} from "./country-order";
import type {TerritoryGeometry} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {createTerritoryOrder} from "./territory-order";
import {createTopologyState} from "./topology-state";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "./world-state-v2";

export type SeedV1FeatureCollection<TFeature> = Readonly<{
  type: "FeatureCollection";
  features: readonly TFeature[];
}>;

export type SeedV1GeometryFeature = Readonly<{
  type: "Feature";
  properties: Readonly<{countryId: string}>;
  geometry: TerritoryGeometry;
}>;

export type SeedV1CapitalFeature = Readonly<{
  type: "Feature";
  properties: Readonly<{
    countryId: string;
    nameKo: string;
    nameEn: string;
    capitalType: string;
    labelRank: number;
  }>;
  geometry: Readonly<{
    type: "Point";
    coordinates: readonly [number, number];
  }>;
}>;

export type SeedCountryCapital = Readonly<{
  countryId: ActiveCountryId;
  nameKo: string;
  nameEn: string;
  capitalType: string;
  labelRank: number;
  coordinates: readonly [number, number];
}>;

export type WorldSeedV1ToV2Input = Readonly<{
  metadata: readonly Country[];
  countryGeometry: SeedV1FeatureCollection<SeedV1GeometryFeature>;
  capitals: SeedV1FeatureCollection<SeedV1CapitalFeature>;
  seedVersion: string;
  policyVersion: string;
}>;

export type MigratedWorldSeedV2 = Readonly<{
  worldState: WorldStateV2;
  countryCapitalsById: Readonly<Record<string, SeedCountryCapital>>;
}>;

const politicalStatusByUnitType: Record<Country["unitType"], CountryPoliticalStatus> = {
  "sovereign-country": "sovereign",
  "dependent-territory": "dependent",
  "disputed-territory": "disputed",
  "military-base": "dependent",
  "buffer-zone": "disputed",
  "uninhabited-territory": "dependent",
};

const assertFeatureCollection = (value: unknown, context: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a GeoJSON FeatureCollection`);
  }
  const collection = value as {type?: unknown; features?: unknown};
  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error(`${context} must be a GeoJSON FeatureCollection`);
  }
};

const readCanonicalText = (value: unknown, context: string) => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${context} must be a non-empty canonical string`);
  }
  return value;
};

const collectUniqueByCountryId = <T extends {properties: {countryId: string}}>(
  values: readonly T[],
  context: string,
) => {
  const byCountryId = new Map<string, T>();
  for (const value of values) {
    const countryId = readCanonicalText(value.properties.countryId, `${context} countryId`);
    if (byCountryId.has(countryId)) {
      throw new Error(`${context} contains duplicate countryId ${countryId}`);
    }
    byCountryId.set(countryId, value);
  }
  return byCountryId;
};

const readCapital = (
  feature: SeedV1CapitalFeature,
  countryId: ActiveCountryId,
): SeedCountryCapital => {
  const {properties, geometry} = feature;
  if (
    geometry.type !== "Point" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length !== 2 ||
    !geometry.coordinates.every(
      (coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate),
    )
  ) {
    throw new Error(`Capital ${countryId} must have a finite Point geometry`);
  }
  if (!Number.isFinite(properties.labelRank)) {
    throw new Error(`Capital ${countryId} labelRank must be finite`);
  }
  return Object.freeze({
    countryId,
    nameKo: readCanonicalText(properties.nameKo, `Capital ${countryId} nameKo`),
    nameEn: readCanonicalText(properties.nameEn, `Capital ${countryId} nameEn`),
    capitalType: readCanonicalText(properties.capitalType, `Capital ${countryId} capitalType`),
    labelRank: properties.labelRank,
    coordinates: Object.freeze([
      geometry.coordinates[0],
      geometry.coordinates[1],
    ]) as readonly [number, number],
  });
};

export function migrateWorldSeedV1ToV2(input: WorldSeedV1ToV2Input): MigratedWorldSeedV2 {
  assertFeatureCollection(input.countryGeometry, "Country geometry seed");
  assertFeatureCollection(input.capitals, "Capital seed");
  const seedVersion = readCanonicalText(input.seedVersion, "seedVersion");
  const policyVersion = readCanonicalText(input.policyVersion, "policyVersion");

  const metadataById = new Map<string, Country>();
  for (const country of input.metadata) {
    const countryId = readCanonicalText(country.id, "Country metadata id");
    if (metadataById.has(countryId)) {
      throw new Error(`Country metadata contains duplicate id ${countryId}`);
    }
    metadataById.set(countryId, country);
  }
  const geometryByCountryId = collectUniqueByCountryId(
    input.countryGeometry.features,
    "Country geometry seed",
  );
  const capitalsByCountryId = collectUniqueByCountryId(input.capitals.features, "Capital seed");

  for (const countryId of geometryByCountryId.keys()) {
    if (!metadataById.has(countryId)) {
      throw new Error(`Country geometry ${countryId} exists without country metadata`);
    }
  }
  for (const countryId of metadataById.keys()) {
    if (!geometryByCountryId.has(countryId)) {
      throw new Error(`Country metadata ${countryId} exists without geometry`);
    }
  }
  for (const countryId of capitalsByCountryId.keys()) {
    if (!metadataById.has(countryId)) {
      throw new Error(`Capital without country metadata: ${countryId}`);
    }
  }

  const countryIdRegistry = createCountryIdRegistry({
    activeCountryIds: metadataById.keys(),
    retiredCountryIds: [],
  });
  const countryOrder = createCountryOrder(countryIdRegistry.activeCountryIds);
  const activeCountryIdByValue = new Map(
    countryOrder.map((countryId) => [countryId as string, countryId]),
  );

  const countriesById: Record<string, CountryEntity> = {};
  const territories: Array<{
    id: ReturnType<typeof deriveTerritoryId>;
    ownerCountryId: ActiveCountryId;
    geometry: TerritoryGeometry;
    properties: {sourceFeatureId: string};
  }> = [];
  const countryCapitalsById: Record<string, SeedCountryCapital> = {};
  for (const countryId of countryOrder) {
    const country = metadataById.get(countryId)!;
    const searchAliases = [
      ...new Set([country.id, country.iso3, country.nameKo, country.mapLabelKo, country.nameEn]),
    ];
    countriesById[countryId] = createCountryEntity({
      id: countryId,
      names: {
        shortKo: country.nameKo,
        officialKo: country.nameKo,
        mapKo: country.mapLabelKo,
        english: country.nameEn,
        searchAliases,
      },
      politicalStatus: politicalStatusByUnitType[country.unitType],
      presentationOverride: null,
      moduleVersions: {capital: 1, core: 1, names: 1},
    });

    const geometryFeature = geometryByCountryId.get(countryId)!;
    territories.push({
      id: deriveTerritoryId({
        kind: "seed",
        seedVersion,
        sourceFeatureId: countryId,
      }),
      ownerCountryId: countryId,
      geometry: geometryFeature.geometry,
      properties: {sourceFeatureId: countryId},
    });

    const capitalFeature = capitalsByCountryId.get(countryId);
    if (capitalFeature) {
      countryCapitalsById[countryId] = readCapital(
        capitalFeature,
        activeCountryIdByValue.get(countryId)!,
      );
    }
  }

  const territoryOrder = createTerritoryOrder(territories.map(({id}) => id));
  const territoryByValue = new Map(territories.map((territory) => [territory.id, territory]));
  const territoriesById = Object.fromEntries(
    territoryOrder.map((territoryId) => [territoryId, territoryByValue.get(territoryId)!]),
  );
  const worldState = createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion,
    policyVersion,
    revision: 0,
    countriesById,
    countryOrder,
    retiredCountryIds: [],
    territoriesById,
    territoryOrder,
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
      presentationRootHash: null,
    },
  });

  return Object.freeze({
    worldState,
    countryCapitalsById: Object.freeze(countryCapitalsById),
  });
}
