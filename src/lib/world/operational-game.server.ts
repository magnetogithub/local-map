import 'server-only';
import fs from 'node:fs';
import {loadProductionCatalogSeed} from './production-catalog-seed.server';
import {loadOperationalCatalog, type OperationalCatalog} from './operational-catalog.server';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair, type CatalogRuntimePair} from '../simulation/catalog-runtime';
import {createSimulationStateV2} from '../simulation/simulation-state-v2';
import {createWorldStateV3} from './world-state-v3';
import {createTerritoryEntityV3} from './territory-entity-v3';
import type {WorldStateV3} from './world-state-v3';

let prepared: ReturnType<typeof prepareOperationalGame> | undefined;
/** Explicit coarse lineage supplies initial state; fine IDs are never old save IDs. */
export function inheritOperationalSeedTerritories(
  source: Pick<WorldStateV3, 'territoriesById'>,
  operational: Pick<OperationalCatalog, 'worldContract' | 'cell' | 'previousParents'>,
) {
  const catalog = operational.worldContract();
  return Object.freeze(Object.fromEntries(catalog.territoryOrder.map(id => {
    const cell = operational.cell(id), parent = operational.previousParents[cell.previousParentOrdinal - 1];
    const origins = parent && (parent.seedParentIds ?? [parent.oldTerritoryId]).map(id => source.territoriesById[id]);
    const original = origins?.[0];
    if (!original || parent.sourceCountryId !== cell.sourceCountryId || original.sourceCountryId !== cell.sourceCountryId ||
        cell.sourceCountryId !== catalog.territoriesById[id].sourceCountryId) throw Error('OPERATIONAL_SEED_SOURCE_MISMATCH');
    if (origins?.some(candidate => !candidate || candidate.sourceCountryId !== original.sourceCountryId ||
        candidate.ownerCountryId !== original.ownerCountryId || candidate.controllerCountryId !== original.controllerCountryId)) throw Error('OPERATIONAL_SEED_CONSENSUS_MISMATCH');
    return [id, createTerritoryEntityV3({...original, id})];
  })));
}
function prepareOperationalGame() {
  const previous = loadProductionCatalogSeed();
  const metadata = readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${previous.bootstrap.metadata.path}`, 'utf8')), previous.bootstrap.catalogRef);
  const source = readCatalogRuntimePair(previous.serializedPair, catalogContractForConsumer(metadata));
  const operational = loadOperationalCatalog(), catalog = operational.worldContract();
  // Read the canonical coarse seed, never an existing game or old grid save.
  const territoriesById = inheritOperationalSeedTerritories(source.world, operational);
  const world = createWorldStateV3({...source.world, catalogRef: catalog.ref, territoryOrder: catalog.territoryOrder, territoriesById}, catalog);
  const simulation = createSimulationStateV2(source.simulation, world);
  const seed: CatalogRuntimePair = Object.freeze({world, simulation, revisions: Object.freeze({worldRevision: 0, simulationRevision: 0})});
  return Object.freeze({catalog, seed});
}
export function createProductionOperationalGame(playerCountryId?: string) {
  const {catalog, seed} = prepared ??= prepareOperationalGame();
  const simulation = playerCountryId === undefined ? seed.simulation : createSimulationStateV2({...seed.simulation, playerCountryId}, seed.world);
  return Object.freeze({pair: Object.freeze({...seed, simulation}), catalog, descriptor: loadOperationalCatalog().descriptor});
}
