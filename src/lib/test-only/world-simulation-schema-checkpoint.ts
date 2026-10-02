import {z} from "zod";

import {canonicalSerialize, canonicalStringify} from "../world/canonical-serializer";
import {sha256Hex} from "../world/sha256";
import type {WorldStateV2} from "../world/world-state-v2";
import {
  createWorldStateV3, deserializeWorldStateV3, serializeWorldStateV3,
  worldStateV3ContentHash, type WorldStateV3,
} from "../world/world-state-v3";
import {createWorldGeometryCatalogContract, type WorldGeometryCatalogContract} from "../world/world-geometry-catalog-ref";
import {
  createAtomicTurnRuntime, type AtomicTurnRuntime, type AtomicTurnSnapshot, type AtomicWorldPort,
} from "../simulation/atomic-turn-runtime";
import {createSimulationStateV1, type SimulationStateV1} from "../simulation/simulation-state";
import {
  assertSimulationStateV2Invariants, deserializeSimulationStateV2,
  migrateSimulationStateV1ToV2, serializeSimulationStateV2, simulationStateV2ContentHash,
  type SimulationStateV2,
} from "../simulation/simulation-state-v2";
import {assertSafeSimulationData} from "../simulation/simulation-contract-primitives";
import {revisionPairSchema} from "../simulation/simulation-clock";
import {migrateWorldStateV2ToV3} from "./world-v2-to-v3-migration";

export type MigratedSchemaPair = AtomicTurnSnapshot<SimulationStateV2, WorldStateV3>;
export type MigratedSchemaRuntime = AtomicTurnRuntime<SimulationStateV2, WorldStateV3>;

/** Preparation only: both candidates must validate before a pair can be returned. */
export function prepareWorldSimulationSchemaMigration(
  input: Parameters<typeof migrateWorldStateV2ToV3>[0] & Readonly<{legacySimulation: SimulationStateV1}>,
): MigratedSchemaPair {
  const {legacySimulation, ...worldInput} = input;
  createSimulationStateV1(legacySimulation, input.legacyWorld);
  const world = migrateWorldStateV2ToV3(worldInput);
  const simulation = migrateSimulationStateV1ToV2(legacySimulation, world);
  return Object.freeze({world, simulation, revisions: Object.freeze({
    worldRevision: world.revision, simulationRevision: simulation.revision,
  })});
}

/** Injected into the existing atomic engine; never selected by production bootstrap. */
export function createWorldV3AtomicPort(catalogInput: WorldGeometryCatalogContract): AtomicWorldPort<WorldStateV3> {
  const catalog = createWorldGeometryCatalogContract(catalogInput);
  return Object.freeze({
    validate(state) {createWorldStateV3(state, catalog);},
    restoreWithRevision: (state, revision) => createWorldStateV3({...state, revision}, catalog),
    contentHash: worldStateV3ContentHash,
  });
}

export function createMigratedSchemaRuntime(
  pair: MigratedSchemaPair, catalog: WorldGeometryCatalogContract,
): MigratedSchemaRuntime {
  assertPairRevisions(pair);
  return createAtomicTurnRuntime(pair.simulation, pair.world, {worldPort: createWorldV3AtomicPort(catalog)});
}

function assertPairRevisions(pair: MigratedSchemaPair): void {
  const revisions = revisionPairSchema.parse(pair.revisions);
  if (revisions.worldRevision !== pair.world.revision || revisions.simulationRevision !== pair.simulation.revision) {
    throw new Error("Schema pair revision mismatch");
  }
}

const pairContentHash = (pair: MigratedSchemaPair) => sha256Hex(canonicalSerialize({
  namespace: "world-simulation-schema-pair.v1", revisions: pair.revisions,
  worldContentHash: worldStateV3ContentHash(pair.world),
  simulationContentHash: simulationStateV2ContentHash(pair.simulation),
}));

const serializedSchemaPairSchema = z.strictObject({
  format: z.literal("world-simulation-schema-pair.v1"),
  world: z.unknown(), simulation: z.unknown(), revisions: revisionPairSchema,
  pairContentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Offline snapshot evidence; no storage, bootstrap, catalog asset copies or UI writes. */
export function serializeMigratedSchemaPair(pair: MigratedSchemaPair, catalog: WorldGeometryCatalogContract): string {
  createWorldStateV3(pair.world, catalog);
  assertSimulationStateV2Invariants(pair.simulation, pair.world);
  assertPairRevisions(pair);
  return canonicalStringify({
    format: "world-simulation-schema-pair.v1", world: serializeWorldStateV3(pair.world),
    simulation: JSON.parse(serializeSimulationStateV2(pair.simulation, pair.world)) as unknown,
    revisions: pair.revisions, pairContentHash: pairContentHash(pair),
  });
}

export function deserializeMigratedSchemaPair(raw: string, catalog: WorldGeometryCatalogContract): MigratedSchemaPair {
  const input: unknown = JSON.parse(raw);
  assertSafeSimulationData(input);
  const saved = serializedSchemaPairSchema.parse(input);
  const world = deserializeWorldStateV3(saved.world, catalog);
  const simulation = deserializeSimulationStateV2(canonicalStringify(saved.simulation), world);
  const pair = Object.freeze({world, simulation, revisions: Object.freeze(saved.revisions)});
  assertPairRevisions(pair);
  if (pairContentHash(pair) !== saved.pairContentHash) throw new Error("Schema pair content hash mismatch");
  return pair;
}

/** Makes the source-pair boundary explicit for test callers. */
export type LegacySchemaPair = Readonly<{world: WorldStateV2; simulation: SimulationStateV1}>;
