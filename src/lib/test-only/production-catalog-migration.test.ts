// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import {expect, it} from "vitest";
import {assertBuildOutput, digest, jsonBytes} from "../../../scripts/prompt14-catalog-core.mjs";
import {createProductionInitialWorldStateV2, createProductionCountryMapColorSeeds} from "../world/initial-world-state-v2";
import {canonicalStringify} from "../world/canonical-serializer";
import {serializeWorldStateV2} from "../world/world-state-v2";
import {worldStateV3ContentHash} from "../world/world-state-v3";
import {createInitialSimulationState} from "../simulation/initial-simulation-state";
import {simulationStateV2ContentHash} from "../simulation/simulation-state-v2";
import {prepareProductionCatalogMigrationAdapter} from "./production-catalog-migration";
import {prepareWorldSimulationSchemaMigration, serializeMigratedSchemaPair, deserializeMigratedSchemaPair} from "./world-simulation-schema-checkpoint";
import {validateTerritoryMigrationMapping} from "./world-v2-to-v3-migration";

const directory = process.env.PROMPT14_CATALOG_OUTPUT;
it.skipIf(!directory)("14-8 migrates the actual production seed/catalog and validates the complete atomic pair", () => {
  const output = path.resolve(directory!); assertBuildOutput(process.cwd(), output);
  const world = createProductionInitialWorldStateV2().worldState;
  const simulation = createInitialSimulationState(world, "KOR");
  const beforeWorld = canonicalStringify(serializeWorldStateV2(world)), beforeSimulation = canonicalStringify(simulation);
  const adapter = prepareProductionCatalogMigrationAdapter(output, world);
  const input = {...adapter, countryMapColors: createProductionCountryMapColorSeeds(), legacySimulation: simulation};
  // Keep evidence outside the strict migration envelope.
  const options = {legacyWorld: adapter.legacyWorld, catalog: adapter.catalog, mapping: adapter.mapping,
    validateCanonicalCoverage: adapter.validateCanonicalCoverage, countryMapColors: input.countryMapColors, legacySimulation: simulation};
  const beforeMapping = canonicalStringify(adapter.mapping);
  const pair = prepareWorldSimulationSchemaMigration(options), again = prepareWorldSimulationSchemaMigration(options);
  const serialized = serializeMigratedSchemaPair(pair, adapter.catalog);
  expect(serializeMigratedSchemaPair(again, adapter.catalog)).toBe(serialized);
  const restored = deserializeMigratedSchemaPair(serialized, adapter.catalog);
  expect(serializeMigratedSchemaPair(restored, adapter.catalog)).toBe(serialized);
  expect(worldStateV3ContentHash(restored.world)).toBe(worldStateV3ContentHash(pair.world));
  expect(simulationStateV2ContentHash(restored.simulation)).toBe(simulationStateV2ContentHash(pair.simulation));
  for (const entry of adapter.mapping) for (const target of entry.targetTerritoryIds) {
    expect(pair.world.territoriesById[target].ownerCountryId).toBe(world.territoriesById[entry.legacyTerritoryId].ownerCountryId);
    expect(pair.world.territoriesById[target].controllerCountryId).toBe(world.territoriesById[entry.legacyTerritoryId].ownerCountryId);
  }
  for (const id of world.countryOrder) {
    expect(pair.world.countriesById[id].mapColor).toBe(input.countryMapColors[id].toUpperCase());
    expect(Number.parseInt(pair.world.countriesById[id].mapColor.slice(1), 16)).toBe(Number.parseInt(input.countryMapColors[id].slice(1), 16));
  }
  expect(pair.world.territoryOrder).toEqual(adapter.catalog.territoryOrder);
  expect(pair.simulation.territorialControlAuthoritiesById).toEqual({}); expect(pair.simulation.territorialControlAuthorityOrder).toEqual([]);
  expect(pair.simulation.countryPresentationAuthoritiesById).toEqual({}); expect(pair.simulation.countryPresentationAuthorityOrder).toEqual([]);
  const first = adapter.mapping[0], second = adapter.mapping[1];
  const validate = (mapping: unknown) => validateTerritoryMigrationMapping(mapping, adapter.legacyWorld, adapter.catalog, adapter.validateCanonicalCoverage);
  expect(() => validate(adapter.mapping.slice(1))).toThrow(/missing legacy/);
  expect(() => validate([...adapter.mapping, first])).toThrow(/Duplicate legacy/);
  expect(() => validate([{...first, targetTerritoryIds: []}, ...adapter.mapping.slice(1)])).toThrow(/empty/);
  expect(() => validate([{...first, targetTerritoryIds: [...first.targetTerritoryIds, first.targetTerritoryIds[0]]}, ...adapter.mapping.slice(1)])).toThrow(/duplicates|Duplicate/);
  const multiple = adapter.mapping.find(e => e.targetTerritoryIds.length > 1)!;
  expect(() => adapter.validateCanonicalCoverage({...multiple, targetTerritoryIds: multiple.targetTerritoryIds.slice(1), catalogRef: adapter.catalog.ref})).toThrow(/Incomplete/);
  expect(() => validate([{...first, targetTerritoryIds: ["territory:catalog:" + "0".repeat(64)]}, ...adapter.mapping.slice(1)])).toThrow(/Unknown target/);
  expect(() => validate([first, {...second, targetTerritoryIds: first.targetTerritoryIds}, ...adapter.mapping.slice(2)])).toThrow(/many-to-one/);
  expect(() => adapter.validateCanonicalCoverage({...first, targetTerritoryIds: second.targetTerritoryIds, catalogRef: adapter.catalog.ref})).toThrow(/cross-border/);
  expect(() => adapter.validateCanonicalCoverage({...first, catalogRef: {...adapter.catalog.ref, geometryRoot: "0".repeat(64)}})).toThrow(/Catalog ref mismatch/);
  expect(canonicalStringify(serializeWorldStateV2(world))).toBe(beforeWorld);
  expect(canonicalStringify(simulation)).toBe(beforeSimulation); expect(canonicalStringify(adapter.mapping)).toBe(beforeMapping);
  fs.writeFileSync(path.join(output, "migration-mapping.json"), `${beforeMapping}\n`);
  fs.writeFileSync(path.join(output, "migration-pair.json"), `${serialized}\n`);
  fs.writeFileSync(path.join(output, "migration-evidence.json"), jsonBytes({status: "pass", ...adapter.evidence,
    mappingSha256: digest(Buffer.from(`${beforeMapping}\n`)), pairSha256: digest(Buffer.from(`${serialized}\n`)),
    worldContentHash: worldStateV3ContentHash(pair.world), simulationContentHash: simulationStateV2ContentHash(pair.simulation),
    ownerPreserved: true, controllerInitializedToOwner: true, rgbPreserved: true, canonicalOrderComplete: true, emptyAuthorities: true,
    inputImmutability: true, deterministicMigration: true, pairRoundTrip: true,
    negativeChecks: ["missing legacy", "duplicate legacy", "duplicate target", "incomplete same-country coverage", "empty targets", "unknown target", "many-to-one", "cross-border targets", "stale root"],
    productionStoreOrBootstrapWrites: false}));
}, 600_000);
