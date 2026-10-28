import 'server-only';
import fs from 'node:fs';
import {loadProductionCatalogSeed} from './production-catalog-seed.server';
import {loadOperationalCatalog} from './operational-catalog.server';
import {createOperationalStateMigration} from './operational-state-migration';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair, type CatalogRuntimePair} from '../simulation/catalog-runtime';
import {createSimulationStateV2} from '../simulation/simulation-state-v2';

let prepared: ReturnType<typeof prepareOperationalGame> | undefined;
function prepareOperationalGame() {
  const previous = loadProductionCatalogSeed();
  const metadata = readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${previous.bootstrap.metadata.path}`, 'utf8')), previous.bootstrap.catalogRef);
  const source = catalogContractForConsumer(metadata);
  const migration = createOperationalStateMigration(source, loadOperationalCatalog());
  const seed = migration.migrate(readCatalogRuntimePair(previous.serializedPair, source), 'initial');
  return Object.freeze({migration, seed});
}

/** Shared server/new-game state factory for the v3 consumer integration (16-04/16-08). */
export function createProductionOperationalGame(playerCountryId?: string) {
  const {migration, seed} = prepared ??= prepareOperationalGame();
  const simulation = playerCountryId === undefined ? seed.simulation
    : createSimulationStateV2({...seed.simulation, playerCountryId}, seed.world);
  const pair = Object.freeze({...seed, simulation});
  return Object.freeze({pair, catalog: migration.catalog, descriptor: loadOperationalCatalog().descriptor});
}

/** Pure candidate preparation. The runtime publishes this pair and catalog together. */
export function prepareProductionOperationalTransition(pair: CatalogRuntimePair) {
  const {migration} = prepared ??= prepareOperationalGame();
  return Object.freeze({expected: pair, next: migration.migrate(pair), catalog: migration.catalog,
    initialSeed: prepared!.seed});
}
