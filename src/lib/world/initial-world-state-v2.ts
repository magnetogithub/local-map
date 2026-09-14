import {
  migrateWorldSeedV1ToV2,
  type MigratedWorldSeedV2,
  type WorldSeedV1ToV2Input,
} from "./seed-v1-to-v2";
import {buildCanonicalTopology} from "./canonical-topology";
import {createWorldStateV2} from "./world-state-v2";

/**
 * Builds the canonical production WorldState v2 seed snapshot.
 * Capital data remains an independent module and is not duplicated in WorldState.
 */
export function createInitialWorldStateV2(
  seed: WorldSeedV1ToV2Input,
): MigratedWorldSeedV2 {
  const migrated = migrateWorldSeedV1ToV2(seed);
  const topology = buildCanonicalTopology(migrated.worldState.territoriesById);
  return Object.freeze({
    worldState: createWorldStateV2({...migrated.worldState, topology}),
    countryCapitalsById: migrated.countryCapitalsById,
  });
}
