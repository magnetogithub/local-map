import {createWorldStateV2} from "../world/world-state-v2";
import {createCountryEntity} from "../world/country-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {createTerritoryEntity} from "../world/territory-entity";
import {createTopologyState} from "../world/topology-state";
import {canonicalStringify} from "../world/canonical-serializer";
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from "../world/world-geometry-catalog-ref";
import type {CountryId} from "../world/country-id";
import type {CanonicalTerritoryCoverageValidator, TerritoryMigrationEntry} from "./world-v2-to-v3-migration";

/** Tiny rectangular coverage fixture, deliberately unrelated to production assets. */
export function createWorldV3SyntheticFixture() {
  const countries = ["AAA", "BBB"].map(id => createCountryEntity({id,
    names: {shortKo: id, officialKo: `${id} Republic`, mapKo: id, english: id, searchAliases: [id]},
    politicalStatus: "sovereign", presentationOverride: null, moduleVersions: {core: 1}}));
  const legacyIds = ["AAA", "BBB"].map(sourceFeatureId => deriveTerritoryId({kind: "seed", seedVersion: "synthetic-v2", sourceFeatureId}));
  const targetIds = ["a", "b", "c"].map(hex => readCatalogTerritoryId(`territory:catalog:${hex.repeat(64)}`));
  const bounds: readonly (readonly [number, number, number, number])[] = [[0, 0, 1, 1], [1, 0, 2, 1], [2, 0, 3, 1]];
  const catalog = createWorldGeometryCatalogContract({ref: {catalogVersion: "synthetic-v3",
    geometryRoot: "1".repeat(64), topologyRoot: "2".repeat(64), renderArtifactRoot: "3".repeat(64),
    manifestPath: "/data/catalogs/synthetic-v3/manifest.json"}, territoryOrder: targetIds,
    territoriesById: Object.fromEntries(targetIds.map((id, index) => [id, {id, sourceCountryId: index < 2 ? "AAA" : "BBB"}]))});
  const legacyBounds = [[0, 0, 2, 1], [2, 0, 3, 1]] as const;
  const legacy = createWorldStateV2({schemaVersion: 2, seedVersion: "synthetic-v2", policyVersion: "world-policy-v1", revision: 7,
    countriesById: Object.fromEntries(countries.map(country => [country.id, country])), countryOrder: countries.map(country => country.id),
    retiredCountryIds: [], territoriesById: Object.fromEntries(legacyIds.map((id, index) => {
      const [x0, y0, x1, y1] = legacyBounds[index];
      return [id, createTerritoryEntity({id, ownerCountryId: countries[index].id,
        geometry: {type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]},
        properties: {sourceFeatureId: countries[index].id}})];
    })), territoryOrder: legacyIds, topology: createTopologyState([]),
    hashRoots: {countriesRootHash: null, territoriesRootHash: null, topologyRootHash: null, presentationRootHash: null}});
  const mapping: readonly TerritoryMigrationEntry[] = [
    {legacyTerritoryId: legacyIds[0], targetTerritoryIds: targetIds.slice(0, 2)},
    {legacyTerritoryId: legacyIds[1], targetTerritoryIds: targetIds.slice(2)},
  ];
  const validateCanonicalCoverage: CanonicalTerritoryCoverageValidator = input => {
    if (canonicalStringify(input.catalogRef) !== canonicalStringify(catalog.ref)) throw new Error("Stale fixture coverage roots");
    const index = legacyIds.indexOf(input.legacyTerritoryId);
    if (index < 0) throw new Error("Unknown canonical legacy coverage");
    const [x0, y0, x1, y1] = legacyBounds[index];
    const pieces = input.targetTerritoryIds.map(id => bounds[targetIds.indexOf(id)]).sort((a, b) => a[0] - b[0]);
    let end: number = x0;
    for (const [left, bottom, right, top] of pieces) {
      if (left !== end || bottom !== y0 || top !== y1 || right > x1 || right <= left) {
        throw new Error("Canonical coverage has a gap, overlap or outside target");
      }
      end = right;
    }
    if (end !== x1) throw new Error("Canonical coverage is incomplete");
    return {sourceCountryId: countries[index].id as CountryId};
  };
  return {legacyIds, targetIds, legacy, catalog, mapping, validateCanonicalCoverage,
    countryMapColors: {AAA: "#aBc123", BBB: "#fEfEfE"}};
}
