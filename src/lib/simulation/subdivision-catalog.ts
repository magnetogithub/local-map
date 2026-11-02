import {deriveTerritoryId} from "../world/territory-id";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import type {SubdivisionReferenceV1} from "./world-effect";
import {compareCanonicalText} from "./simulation-contract-primitives";

export type SubdivisionCatalogSummary = Readonly<{
  ref: SubdivisionReferenceV1;
  parentCountryId: string;
  nameKo: string;
  nameEn: string;
  materializable: boolean;
}>;

export type MaterializedSubdivision = SubdivisionCatalogSummary & Readonly<{
  geometry: TerritoryGeometry;
}>;

export type SubdivisionCatalog = Readonly<{
  listCountry(parentCountryId: string): readonly SubdivisionCatalogSummary[];
  inspect(ref: SubdivisionReferenceV1): SubdivisionCatalogSummary | null;
  materialize(ref: SubdivisionReferenceV1): MaterializedSubdivision | null;
}>;

type FixtureFeature = Readonly<{
  type: "Feature";
  properties: Readonly<{
    countryId: string;
    parentCountryId: string;
    nameKo: string;
    nameEn: string;
  }>;
  geometry: unknown;
}>;

export type SupportedSubdivisionFixture = Readonly<{
  type: "FeatureCollection";
  scenario: "china-provinces-test-v1" | "usa-50-states-test-v1";
  rollbackCountryId: "CHN" | "USA";
  features: readonly FixtureFeature[];
}>;

export type ProductionSubdivisionAsset = Readonly<{
  type: "FeatureCollection";
  scenario: "china-admin1-v1" | "usa-admin1-v1";
  rollbackCountryId: "CHN" | "USA";
  features: readonly FixtureFeature[];
}>;

export type SerializedProductionSubdivisionCatalog = Readonly<{
  catalogVersion: "production-subdivision-catalog.v1";
  assets: readonly ProductionSubdivisionAsset[];
}>;

const CATALOG_ID = "natural-earth-admin1-test";
const expectedFixtureCount = Object.freeze({
  "china-provinces-test-v1": 31,
  "usa-50-states-test-v1": 50,
});
const expectedProductionCount = Object.freeze({
  "china-admin1-v1": 31,
  "usa-admin1-v1": 50,
});

const refKey = (ref: SubdivisionReferenceV1) =>
  `${ref.catalogId}\u0000${ref.sourceVersion}\u0000${ref.subdivisionId}`;

/**
 * Test-only adapter for the two checked-in, versioned boundary fixtures. It deliberately
 * has no generic GeoJSON ingestion method; production catalogs must implement the port.
 */
function createCatalog(
  fixtures: readonly (SupportedSubdivisionFixture | ProductionSubdivisionAsset)[],
  catalogId: string,
  expectedCounts: Readonly<Record<string, number>>,
): SubdivisionCatalog {
  const byKey = new Map<string, MaterializedSubdivision>();
  const byCountry = new Map<string, MaterializedSubdivision[]>();

  for (const fixture of fixtures) {
    const expectedCount = expectedCounts[fixture.scenario];
    if (expectedCount === undefined) throw new Error(`Unsupported subdivision source: ${fixture.scenario}`);
    if (fixture.features.length !== expectedCount) {
      throw new Error(`${fixture.scenario} must contain exactly ${expectedCount} subdivisions`);
    }
    for (const feature of fixture.features) {
      if (
        feature.type !== "Feature"
        || feature.properties.parentCountryId !== fixture.rollbackCountryId
      ) {
        throw new Error(`${fixture.scenario} contains an invalid parent country`);
      }
      const ref = Object.freeze({
        catalogId,
        sourceVersion: fixture.scenario,
        subdivisionId: feature.properties.countryId,
      });
      const geometry = createTerritoryEntity({
        id: deriveTerritoryId({
          kind: "seed",
          seedVersion: fixture.scenario,
          sourceFeatureId: feature.properties.countryId,
        }),
        ownerCountryId: null,
        geometry: feature.geometry,
        properties: {sourceFeatureId: feature.properties.countryId},
      }).geometry;
      const entry: MaterializedSubdivision = Object.freeze({
        ref,
        parentCountryId: fixture.rollbackCountryId,
        nameKo: feature.properties.nameKo,
        nameEn: feature.properties.nameEn,
        materializable: true,
        geometry,
      });
      const key = refKey(ref);
      if (byKey.has(key)) throw new Error(`Duplicate subdivision ref: ${key}`);
      byKey.set(key, entry);
      const countryEntries = byCountry.get(entry.parentCountryId) ?? [];
      countryEntries.push(entry);
      byCountry.set(entry.parentCountryId, countryEntries);
    }
  }

  for (const entries of byCountry.values()) {
    entries.sort((left, right) =>
      compareCanonicalText(left.ref.subdivisionId, right.ref.subdivisionId));
    Object.freeze(entries);
  }

  return Object.freeze({
    listCountry(parentCountryId) {
      return byCountry.get(parentCountryId) ?? Object.freeze([]);
    },
    inspect(ref) {
      const entry = byKey.get(refKey(ref));
      if (!entry) return null;
      return Object.freeze({
        ref: entry.ref,
        parentCountryId: entry.parentCountryId,
        nameKo: entry.nameKo,
        nameEn: entry.nameEn,
        materializable: entry.materializable,
      });
    },
    materialize(ref) {
      return byKey.get(refKey(ref)) ?? null;
    },
  });
}

export function createSubdivisionCatalogTestAdapter(
  fixtures: readonly SupportedSubdivisionFixture[],
): SubdivisionCatalog {
  return createCatalog(fixtures, CATALOG_ID, expectedFixtureCount);
}

export function createProductionSubdivisionCatalog(
  serialized: SerializedProductionSubdivisionCatalog,
): SubdivisionCatalog {
  if (serialized.catalogVersion !== "production-subdivision-catalog.v1") {
    throw new Error("Unsupported production subdivision catalog version");
  }
  const countries = serialized.assets.map((asset) => asset.rollbackCountryId).sort();
  if (countries.join(",") !== "CHN,USA") {
    throw new Error("Production subdivision catalog must contain exactly CHN and USA");
  }
  return createCatalog(serialized.assets, "natural-earth-admin1-v1", expectedProductionCount);
}

