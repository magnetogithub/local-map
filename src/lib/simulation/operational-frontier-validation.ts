import {OPERATIONAL_CATALOG_VERSION, type OperationalWorldView} from '../world/operational-catalog';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {canonicalStringify} from '../world/canonical-serializer';
import type {OperationalFrontierRequest, OperationalFrontierResolver} from './operational-frontier-contract';
import type {TurnResolutionV1} from './turn-resolution';
import {MAX_AUTHORITY_TERRITORIES} from './simulation-state-v2';

export type OperationalFrontierValidation = Readonly<{
  world: OperationalWorldView;
  resolve: OperationalFrontierResolver;
  /** Supplied by the provider's host session, never by the model. */
  issuedScopes?: readonly OperationalFrontierRequest[];
}>;

export const operationalScopeKey = (scope: OperationalFrontierRequest) => canonicalStringify({
  ...scope, direction: scope.direction ?? null, reference: scope.reference ?? null, regionQuery: scope.regionQuery ?? null,
});

/** Re-runs scope selection before any region expansion or world mutation, including DEBUG. */
export function validateOperationalFrontierEffects(
  resolution: TurnResolutionV1,
  world: OperationalWorldView,
  binding?: OperationalFrontierValidation,
): void {
  const operational = world.catalogRef.catalogVersion === OPERATIONAL_CATALOG_VERSION;
  let aggregateCount = 0;
  const verified = new Map<string, readonly string[]>();
  const issued = binding?.issuedScopes && new Set(binding.issuedScopes.map(operationalScopeKey));
  for (const effect of resolution.worldEffects) {
    if (effect.type !== 'territory.occupy' && effect.type !== 'territory.liberate' && effect.type !== 'territory.transferOwnership') continue;
    const scope = effect.frontierScope;
    if (!operational && !scope) continue; // Preserve the previous catalog's region contract.
    if (!scope) throw Error('FRONTIER_SCOPE_REQUIRED');
    if (!binding) throw Error('FRONTIER_RESOLVER_REQUIRED');
    assertWorldGeometryCatalogRefMatches(world.catalogRef, binding.world.catalogRef);
    assertWorldGeometryCatalogRefMatches(world.catalogRef, scope.catalogRef);
    if (binding.world !== world && (binding.world.revision !== world.revision || binding.world.territoriesById !== world.territoriesById)) throw Error('FRONTIER_WORLD_MISMATCH');
    if (scope.baseWorldRevision !== world.revision || resolution.baseWorldRevision !== world.revision) throw Error('STALE_FRONTIER_REVISION');
    const operation = effect.type === 'territory.transferOwnership' ? 'transfer' : effect.type === 'territory.occupy' ? 'occupy' : 'liberate';
    if (scope.actorCountryId !== effect.actorCountryId || scope.targetCountryId !== effect.targetCountryId || scope.operation !== operation) throw Error('FRONTIER_EFFECT_BINDING_MISMATCH');
    if (effect.type === 'territory.transferOwnership' && effect.newOwnerCountryId !== effect.targetCountryId) throw Error('FRONTIER_EFFECT_BINDING_MISMATCH');
    if (effect.regionRefs?.length) throw Error('FRONTIER_REGION_REPLACEMENT');
    const key = operationalScopeKey(scope);
    if (issued && !issued.has(key)) throw Error('FRONTIER_SELECTION_NOT_LOOKED_UP');
    let ids = verified.get(key);
    if (!ids) {
      const selected = binding.resolve(world, scope);
      assertWorldGeometryCatalogRefMatches(selected.catalogRef, world.catalogRef);
      if (selected.baseWorldRevision !== world.revision || selected.actorCountryId !== scope.actorCountryId || selected.targetCountryId !== scope.targetCountryId || selected.operation !== scope.operation) throw Error('FRONTIER_SELECTION_BINDING_MISMATCH');
      ids = selected.cellIds; verified.set(key, ids);
    }
    if (!ids.length || ids.length !== effect.territoryIds.length || ids.some((id, i) => effect.territoryIds[i] !== id)) throw Error('FRONTIER_SELECTION_MISMATCH');
    for (const id of ids) if (!Object.hasOwn(world.territoriesById, id)) throw Error('UNKNOWN_FRONTIER_CELL');
    aggregateCount += ids.length;
    if (aggregateCount > MAX_AUTHORITY_TERRITORIES) throw Error('FRONTIER_AGGREGATE_CAP');
  }
}
