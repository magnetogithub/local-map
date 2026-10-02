import {createWorldStateV2, type WorldStateV2} from "../world/world-state-v2";
import {createWorldStateV3, type WorldStateV3} from "../world/world-state-v3";
import type {CountryEntityV3} from "../world/country-entity-v3";
import {readCanonicalMapColor} from "../world/country-entity-v3";
import type {TerritoryEntityV3} from "../world/territory-entity-v3";
import {readTerritoryId, type TerritoryId} from "../world/territory-id";
import type {CountryId} from "../world/country-id";
import {
  createWorldGeometryCatalogContract, readCatalogTerritoryId,
  type WorldGeometryCatalogContract, type WorldGeometryCatalogRef,
} from "../world/world-geometry-catalog-ref";
import {
  assertWorldV3Keys, assertWorldV3RecordOrder, compareWorldV3Ids,
  readWorldV3Array, readWorldV3CountryId, readWorldV3Order, readWorldV3Record,
} from "../world/world-v3-validation";

export type TerritoryMigrationEntry = Readonly<{
  legacyTerritoryId: TerritoryId;
  targetTerritoryIds: readonly TerritoryId[];
}>;

/**
 * Required trusted build/CI port. It must prove that the entire target set partitions
 * this legacy territory's canonical 2020 coverage using the locked P0 policy and
 * catalog roots, and return its original source country. Current owner is unsuitable:
 * V2 transfers/unclaims and dissolved countries do not change canonical provenance.
 * Implementations throw for gaps, overlap, cross-border targets or stale evidence.
 * No geometry computation belongs in the runtime migration engine.
 */
export type CanonicalTerritoryCoverageValidator = (input: Readonly<{
  legacyTerritoryId: TerritoryId;
  targetTerritoryIds: readonly TerritoryId[];
  catalogRef: WorldGeometryCatalogRef;
}>) => Readonly<{sourceCountryId: CountryId}>;

export function validateTerritoryMigrationMapping(
  value: unknown, legacy: WorldStateV2, catalog: WorldGeometryCatalogContract,
  validateCanonicalCoverage: CanonicalTerritoryCoverageValidator,
): readonly TerritoryMigrationEntry[] {
  const mapping = readWorldV3Array(value, "Territory migration mapping");
  if (typeof validateCanonicalCoverage !== "function") {
    throw new Error("Canonical coverage validator is required");
  }
  const legacyIds = new Set(legacy.territoryOrder);
  const seenLegacy = new Set<TerritoryId>();
  const seenTargets = new Set<TerritoryId>();
  const entries = mapping.map((item) => {
    const input = readWorldV3Record(item, "TerritoryMigrationEntry");
    assertWorldV3Keys(input, ["legacyTerritoryId", "targetTerritoryIds"], "TerritoryMigrationEntry");
    const legacyTerritoryId = readTerritoryId(input.legacyTerritoryId);
    if (!legacyIds.has(legacyTerritoryId)) throw new Error("Unknown legacy territory in mapping");
    if (seenLegacy.has(legacyTerritoryId)) throw new Error("Duplicate legacy territory in mapping");
    seenLegacy.add(legacyTerritoryId);
    const targetTerritoryIds = readWorldV3Order(input.targetTerritoryIds, readCatalogTerritoryId, "targetTerritoryIds");
    if (!targetTerritoryIds.length) throw new Error("Migration targets must not be empty");
    for (const id of targetTerritoryIds) {
      if (!Object.hasOwn(catalog.territoriesById, id)) throw new Error("Unknown target territory in mapping");
      if (seenTargets.has(id)) throw new Error("Duplicate target / many-to-one mapping is forbidden");
      seenTargets.add(id);
    }
    return Object.freeze({legacyTerritoryId, targetTerritoryIds});
  }).sort((a, b) => compareWorldV3Ids(a.legacyTerritoryId, b.legacyTerritoryId));
  if (seenLegacy.size !== legacyIds.size) throw new Error("Migration mapping is missing legacy territories");
  if (seenTargets.size !== catalog.territoryOrder.length) throw new Error("Migration mapping is missing catalog targets");
  for (const entry of entries) {
    const proof = readWorldV3Record(validateCanonicalCoverage({...entry, catalogRef: catalog.ref}), "Canonical coverage result");
    assertWorldV3Keys(proof, ["sourceCountryId"], "Canonical coverage result");
    const sourceCountryId = readWorldV3CountryId(proof.sourceCountryId, "Canonical coverage source country");
    for (const id of entry.targetTerritoryIds) {
      if (catalog.territoriesById[id].sourceCountryId !== sourceCountryId) {
        throw new Error("Migration source-country coverage mismatch");
      }
    }
  }
  return Object.freeze(entries);
}

/** Test-only dry run: no store, bootstrap, simulation, history or map writes. */
export function migrateWorldStateV2ToV3(input: Readonly<{
  legacyWorld: WorldStateV2;
  catalog: WorldGeometryCatalogContract;
  mapping: unknown;
  countryMapColors: Readonly<Record<string, string>>;
  validateCanonicalCoverage: CanonicalTerritoryCoverageValidator;
}>): WorldStateV3 {
  const options = readWorldV3Record(input, "World V2 to V3 migration input");
  assertWorldV3Keys(options, ["legacyWorld", "catalog", "mapping", "countryMapColors", "validateCanonicalCoverage"], "World V2 to V3 migration input");
  const legacy = createWorldStateV2(input.legacyWorld);
  const catalog = createWorldGeometryCatalogContract(input.catalog);
  const mapping = validateTerritoryMigrationMapping(input.mapping, legacy, catalog, input.validateCanonicalCoverage);
  const colors = readWorldV3Record(input.countryMapColors, "Migration countryMapColors");
  assertWorldV3RecordOrder(colors, legacy.countryOrder, "Migration countryMapColors");
  const countriesById: Record<string, CountryEntityV3> = {};
  for (const id of legacy.countryOrder) {
    const color = colors[id];
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Invalid legacy map color");
    countriesById[id] = {...legacy.countriesById[id], mapColor: readCanonicalMapColor(color.toUpperCase())};
  }
  const territoriesById: Record<string, TerritoryEntityV3> = {};
  for (const entry of mapping) {
    const ownerCountryId = legacy.territoriesById[entry.legacyTerritoryId].ownerCountryId;
    for (const id of entry.targetTerritoryIds) {
      territoriesById[id] = {id, sourceCountryId: catalog.territoriesById[id].sourceCountryId,
        ownerCountryId, controllerCountryId: ownerCountryId};
    }
  }
  return createWorldStateV3({schemaVersion: 3, seedVersion: legacy.seedVersion,
    policyVersion: legacy.policyVersion, revision: legacy.revision,
    countriesById, countryOrder: legacy.countryOrder,
    retiredCountryIds: new Set([...legacy.retiredCountryIds].sort(compareWorldV3Ids)),
    territoriesById, territoryOrder: catalog.territoryOrder, catalogRef: catalog.ref}, catalog);
}
