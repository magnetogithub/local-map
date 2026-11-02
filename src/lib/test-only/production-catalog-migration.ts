import fs from "node:fs";
import path from "node:path";

import {canonical, digest, generateAtoms, loadLockedInputs, validateAtoms} from "../../../scripts/prompt14-catalog-core.mjs";
import {verifyCatalogArtifactBytes} from "../../../scripts/prompt14-catalog-artifacts.mjs";
import {buildCatalogTopology, territoryIdForAtom} from "../../../scripts/prompt14-catalog-topology.mjs";
import {verifySharedP0} from "../../../scripts/prompt14-shared-topology.mjs";
import type {WorldStateV2} from "../world/world-state-v2";
import {createWorldStateV2} from "../world/world-state-v2";
import {deriveTerritoryId} from "../world/territory-id";
import type {TerritoryId} from "../world/territory-id";
import {
  assertWorldGeometryCatalogRefMatches, createWorldGeometryCatalogContract,
  readCatalogTerritoryId, type WorldGeometryCatalogRef,
} from "../world/world-geometry-catalog-ref";
import type {CanonicalTerritoryCoverageValidator, TerritoryMigrationEntry} from "./world-v2-to-v3-migration";

/** Offline build/test adapter. No production bootstrap, store, browser or persistence imports. */
export function prepareProductionCatalogMigrationAdapter(
  directory: string, legacyInput: WorldStateV2, expectedRef?: WorldGeometryCatalogRef,
) {
  const root = process.cwd();
  const legacyWorld = createWorldStateV2(legacyInput);
  const verified = verifyCatalogArtifactBytes(directory);
  if (expectedRef) assertWorldGeometryCatalogRefMatches(verified.ref, expectedRef);
  const inputs = loadLockedInputs(root);
  const atoms = generateAtoms(inputs);
  const base = path.join(directory, "build-only", verified.ref.catalogVersion);
  const index = JSON.parse(fs.readFileSync(path.join(base, "catalog.json"), "utf8"));
  const geometry = JSON.parse(fs.readFileSync(path.join(base, "geometry.geojson"), "utf8"));
  const entryIds: TerritoryId[] = index.entries.map((e: {id: unknown}) => readCatalogTerritoryId(e.id));
  const catalog = createWorldGeometryCatalogContract({ref: verified.ref, territoryOrder: index.territoryOrder,
    territoriesById: Object.fromEntries(index.entries.map((e: {id: string; sourceCountryId: string}) => [e.id, {id: e.id, sourceCountryId: e.sourceCountryId}]))});
  if (canonical(entryIds) !== canonical(catalog.territoryOrder)) throw new Error("Catalog entry/order mismatch");
  const geometries = new Map<string, unknown>(geometry.features.map((f: {properties: {territoryId: string}; geometry: unknown}) => [f.properties.territoryId, f.geometry]));
  if (geometries.size !== atoms.length || entryIds.length !== atoms.length) throw new Error("Catalog geometry/identity count mismatch");
  const entriesById = new Map<string, {canonicalAtomKey: string; sourceCountryId: string}>(index.entries.map((e: {id: string; canonicalAtomKey: string; sourceCountryId: string}) => [e.id, e]));
  for (const atom of atoms) {
    const id = territoryIdForAtom(atom.canonicalAtomKey), entry = entriesById.get(id);
    if (!entry || entry.canonicalAtomKey !== atom.canonicalAtomKey || entry.sourceCountryId !== atom.identity.sourceCountryId ||
      canonical(geometries.get(id)) !== canonical(atom.geometry)) throw new Error("Actual catalog geometry differs from the locked source atom");
  }
  // Full geometry/coverage/topology on the actual bytes, never merely a country-ID assertion.
  const catalogAtoms = atoms.map(atom => ({...atom, geometry: geometries.get(territoryIdForAtom(atom.canonicalAtomKey))}));
  const coverage = validateAtoms(catalogAtoms, inputs);
  const topology = buildCatalogTopology(catalogAtoms, inputs.p0);
  const topologyOnDisk = JSON.parse(fs.readFileSync(path.join(base, "topology.json"), "utf8"));
  if (canonical(topology) !== canonical(topologyOnDisk)) throw new Error("Actual topology bytes do not match source boundary ownership");

  const originalSeed = JSON.parse(fs.readFileSync(path.join(root, "public/data/maps/countries-10m.geojson"), "utf8"));
  const sourceByLegacy = new Map<TerritoryId, string>();
  const legacyFeatures = originalSeed.features.map((feature: {properties: {countryId: string}; geometry: unknown}) => {
    const countryId = feature.properties.countryId;
    const id = deriveTerritoryId({kind: "seed", seedVersion: legacyWorld.seedVersion, sourceFeatureId: countryId});
    const territory = legacyWorld.territoriesById[id];
    if (!territory || territory.properties.sourceFeatureId !== countryId || canonical(territory.geometry) !== canonical(feature.geometry)) {
      throw new Error("Legacy coverage is not the pinned canonical production seed");
    }
    sourceByLegacy.set(id, countryId);
    return {...feature, geometry: territory.geometry};
  });
  if (sourceByLegacy.size !== legacyWorld.territoryOrder.length) throw new Error("Legacy source coverage has missing or extra territories");
  const p0Bytes = fs.readFileSync(path.join(root, "data/derived/prompt14/shared-game-p0.geojson"));
  const legacyToDerived = verifySharedP0({type: "FeatureCollection", features: legacyFeatures}, inputs.p0, p0Bytes, p0Bytes);
  if (!legacyToDerived.pass) throw new Error("Legacy/derived coverage difference is not explained by the approved bounded source policy");
  const countryProofs = new Map(legacyToDerived.countries.map((c: {countryId: string}) => [c.countryId, c]));
  const targetSets = new Map<string, readonly TerritoryId[]>();
  for (const countryId of sourceByLegacy.values()) targetSets.set(countryId, Object.freeze(catalog.territoryOrder.filter(id => catalog.territoriesById[id].sourceCountryId === countryId)));
  const mapping: readonly TerritoryMigrationEntry[] = Object.freeze(legacyWorld.territoryOrder.map(legacyTerritoryId => {
    const source = sourceByLegacy.get(legacyTerritoryId)!;
    return Object.freeze({legacyTerritoryId, targetTerritoryIds: targetSets.get(source)!});
  }));
  const validateCanonicalCoverage: CanonicalTerritoryCoverageValidator = input => {
    assertWorldGeometryCatalogRefMatches(input.catalogRef, catalog.ref);
    const sourceCountryId = sourceByLegacy.get(input.legacyTerritoryId);
    if (!sourceCountryId || !countryProofs.has(sourceCountryId)) throw new Error("Unknown or unexplained legacy coverage");
    if (canonical(input.targetTerritoryIds) !== canonical(targetSets.get(sourceCountryId))) throw new Error("Incomplete, duplicate, unknown, or cross-border coverage target set");
    const proof = coverage.coverage.find((c: {countryId: string}) => c.countryId === sourceCountryId);
    if (!proof?.pass || !topology.evidence.completeBoundaryCoverage) throw new Error("Actual catalog partition has gap, overlap, or cross-border geometry");
    return {sourceCountryId: catalog.territoriesById[input.targetTerritoryIds[0]].sourceCountryId};
  };
  return Object.freeze({legacyWorld, catalog, mapping, validateCanonicalCoverage,
    evidence: {catalogRef: catalog.ref, verifiedArtifacts: verified.verifiedArtifactCount,
      sourceLockSha256: digest(fs.readFileSync("data/source-locks/prompt14-derived-game-input-lock.json")),
      countries: sourceByLegacy.size, targetTerritories: entryIds.length, coverage, topology: topology.evidence,
      legacyToDerived, actualGeometryMatchedLockedAtoms: true, canonicalSeedCoverageValidated: true}});
}
