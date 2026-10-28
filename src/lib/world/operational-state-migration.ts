import type {OperationalCatalog} from './operational-catalog.server';
import {OPERATIONAL_CATALOG_VERSION} from './operational-catalog';
import {assertWorldGeometryCatalogRefMatches, type WorldGeometryCatalogContract} from './world-geometry-catalog-ref';
import {createWorldStateV3, isValidatedWorldStateV3} from './world-state-v3';
import type {TerritoryEntityV3} from './territory-entity-v3';
import type {TerritoryId} from './territory-id';
import {createSimulationStateV2, type TerritorialControlAuthority} from '../simulation/simulation-state-v2';
import type {CatalogRuntimePair} from '../simulation/catalog-runtime';
import type {CatalogRegionIndex, RegionReference} from '../simulation/catalog-region';

export const PREVIOUS_OPERATIONAL_CATALOG_VERSION = 'catalog-v1-73e30c25c9637d6376cb65afa82483c6';
type CatalogMapping = Pick<OperationalCatalog, 'ref' | 'previousParents' | 'previousMembership' | 'worldContract'>;

/** Only the current game's previous catalog -> pinned operational cells. No geometry work. */
export function createOperationalStateMigration(source: WorldGeometryCatalogContract, target: CatalogMapping) {
  if (source.ref.catalogVersion !== PREVIOUS_OPERATIONAL_CATALOG_VERSION
    || target.ref.catalogVersion !== OPERATIONAL_CATALOG_VERSION) throw Error('UNSUPPORTED_OPERATIONAL_CATALOG_TRANSITION');
  const catalog = target.worldContract();
  assertWorldGeometryCatalogRefMatches(catalog.ref, target.ref);
  if (target.previousParents.length !== source.territoryOrder.length) throw Error('OPERATIONAL_PREVIOUS_COVERAGE');
  const children = new Map<string, readonly TerritoryId[]>(), covered = new Set<string>();
  for (const parent of target.previousParents) {
    const previous = source.territoriesById[parent.oldTerritoryId];
    if (!previous || previous.sourceCountryId !== parent.sourceCountryId || children.has(parent.oldTerritoryId)) {
      throw Error('OPERATIONAL_PREVIOUS_PARENT_MISMATCH');
    }
    const members = target.previousMembership(parent.oldTerritoryId);
    if (!members.length || members.length !== parent.count) throw Error('OPERATIONAL_PREVIOUS_COVERAGE');
    const ids = members.map(cell => {
      const entry = catalog.territoriesById[cell.id];
      if (!entry || cell.previousParentOrdinal !== parent.ordinal || cell.sourceCountryId !== parent.sourceCountryId
        || entry.sourceCountryId !== parent.sourceCountryId || covered.has(cell.id)) throw Error('OPERATIONAL_PREVIOUS_CELL_MISMATCH');
      covered.add(cell.id);
      return cell.id;
    }).sort();
    children.set(parent.oldTerritoryId, Object.freeze(ids));
  }
  if (covered.size !== catalog.territoryOrder.length || source.territoryOrder.some(id => !children.has(id))) {
    throw Error('OPERATIONAL_PREVIOUS_COVERAGE');
  }
  const territoryIds = (ids: readonly string[]): readonly TerritoryId[] => {
    const result = new Set<TerritoryId>();
    for (const id of ids) {
      const membership = children.get(id);
      if (!membership) throw Error(`UNRESOLVED_PREVIOUS_TERRITORY: ${id}`);
      membership.forEach(cellId => result.add(cellId));
    }
    return Object.freeze([...result].sort());
  };
  const migrate = (pair: CatalogRuntimePair, mode: 'initial' | 'transition' = 'transition'): CatalogRuntimePair => {
    assertWorldGeometryCatalogRefMatches(pair.world.catalogRef, source.ref);
    if (pair.revisions.worldRevision !== pair.world.revision || pair.revisions.simulationRevision !== pair.simulation.revision) {
      throw Error('STALE_CATALOG_REVISION_PAIR');
    }
    if (!isValidatedWorldStateV3(pair.world, source)) createWorldStateV3(pair.world, source);
    createSimulationStateV2(pair.simulation, pair.world);
    if (mode === 'initial' && (pair.world.revision !== 0 || pair.simulation.revision !== 0
      || pair.simulation.turnNumber !== 0 || pair.simulation.history.committedTurnCount !== 0)) throw Error('INITIAL_OPERATIONAL_GAME_REQUIRES_SEED');
    const territoriesById: Record<string, TerritoryEntityV3> = {};
    for (const [oldId, ids] of children) {
      const parent = pair.world.territoriesById[oldId];
      for (const id of ids) territoriesById[id] = {
        id, sourceCountryId: catalog.territoriesById[id].sourceCountryId,
        ownerCountryId: parent.ownerCountryId, controllerCountryId: parent.controllerCountryId,
      };
    }
    const revisionDelta = mode === 'initial' ? 0 : 1;
    const world = createWorldStateV3({...pair.world, revision: pair.world.revision + revisionDelta,
      catalogRef: catalog.ref, territoryOrder: catalog.territoryOrder, territoriesById}, catalog);
    const authorities: Record<string, TerritorialControlAuthority> = {};
    for (const id of pair.simulation.territorialControlAuthorityOrder) {
      const authority = pair.simulation.territorialControlAuthoritiesById[id];
      authorities[id] = {...authority, allowedTerritoryIds: territoryIds(authority.allowedTerritoryIds)};
    }
    // Pending actions and narrative records contain natural language/country IDs,
    // not executable territory/region references. Preserve them without guessing
    // replacements in text. Unknown structured fields fail the strict parser.
    const simulation = createSimulationStateV2({...pair.simulation,
      revision: pair.simulation.revision + revisionDelta, territorialControlAuthoritiesById: authorities}, world);
    return Object.freeze({world, simulation, revisions: Object.freeze({worldRevision: world.revision, simulationRevision: simulation.revision})});
  };
  return Object.freeze({catalog, migrate, territoryIds});
}

/** UI/tool-held references are rebound by source identity, never by display name or a capped action lookup. */
export function migrateOperationalRegionReference(countryId: string, ref: RegionReference,
  source: CatalogRegionIndex, target: CatalogRegionIndex): Readonly<{reference: RegionReference; territoryIds: readonly string[]}> {
  if (source.catalogRef?.catalogVersion !== PREVIOUS_OPERATIONAL_CATALOG_VERSION
    || target.catalogRef?.catalogVersion !== OPERATIONAL_CATALOG_VERSION) throw Error('UNSUPPORTED_OPERATIONAL_REGION_TRANSITION');
  const previous = source.lookup(countryId, ref);
  const reference = Object.freeze({catalogId: target.catalogRef.catalogVersion,
    sourceVersion: target.catalogRef.geometryRoot, subdivisionId: previous.ref.subdivisionId});
  const current = target.lookup(countryId, reference);
  return Object.freeze({reference: current.ref, territoryIds: current.territoryIds});
}
