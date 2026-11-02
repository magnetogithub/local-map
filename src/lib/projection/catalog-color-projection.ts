import {catalogContractForConsumer,createCatalogMapConsumerProjection,updateCatalogMapConsumerProjection,type CatalogMapConsumerProjection} from './catalog-map-consumer-projection';
import {isValidatedWorldStateV3} from '../world/world-state-v3';
import type {CatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import type {WorldStateV3} from '../world/world-state-v3';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import {canonicalStringify} from '../world/canonical-serializer';
import {mapColorPresentation} from '../world/country-map-color';

/** Detect a color-only commit/undo without rebuilding geometry, labels, panels or indexes. */
export function updateCatalogColorProjection(previous: CatalogMapConsumerProjection, world: WorldStateV3) {
  assertWorldGeometryCatalogRefMatches(previous.catalogRef, world.catalogRef);
  if(!isValidatedWorldStateV3(world,catalogContractForConsumer(previous.metadata)))return null;
  const before = previous.world;
  if (before.countryOrder.length !== world.countryOrder.length || before.territoryOrder.length !== world.territoryOrder.length) return null;
  const changedCountries: string[] = [];
  for (let i = 0; i < world.countryOrder.length; i++) {
    const id = world.countryOrder[i]; if (before.countryOrder[i] !== id) return null;
    const a = before.countriesById[id], b = world.countriesById[id];
    // Names and module versions are small; never serialize the whole world/catalog.
    const {mapColor: ac, ...ap} = a, {mapColor: bc, ...bp} = b;
    if (a !== b && canonicalStringify(ap) !== canonicalStringify(bp)) return null;
    if (ac !== bc) changedCountries.push(id);
  }
  if (before.territoriesById !== world.territoriesById) {
    for (let i = 0; i < world.territoryOrder.length; i++) {
      const id = world.territoryOrder[i]; if (before.territoryOrder[i] !== id) return null;
      const a = before.territoriesById[id], b = world.territoriesById[id];
      if (a.ownerCountryId !== b.ownerCountryId || a.controllerCountryId !== b.controllerCountryId || a.sourceCountryId !== b.sourceCountryId) return null;
    }
  }
  const affected = new Set<string>();
  for (const country of changedCountries) {
    for (const id of previous.ownedByCountry[country] ?? []) affected.add(id);
    for (const id of previous.controlledByCountry[country] ?? []) affected.add(id);
  }
  const featuresById = {...previous.featuresById}, changedFeatureIds: string[] = [];
  for (const id of [...affected].sort()) {
    const t = world.territoriesById[id], presented = t.controllerCountryId ?? t.ownerCountryId;
    const mapColor = presented ? world.countriesById[presented].mapColor : '#D6D3C7';
    if (featuresById[id].mapColor === mapColor) continue;
    featuresById[id] = {...featuresById[id], mapColor}; changedFeatureIds.push(id);
  }
  return Object.freeze({projection:Object.freeze({...previous,world,appliedRevision:world.revision,featuresById,
    search:Object.freeze({...previous.search,revision:world.revision}),panel:Object.freeze({...previous.panel,revision:world.revision,appliedRevision:world.revision})}),
    changedFeatureIds:Object.freeze(changedFeatureIds),changedCountryIds:Object.freeze(changedCountries)});
}

export function catalogColorFeatureState(mapColor: string) {
  return mapColorPresentation(mapColor);
}

/** Shared by the React shell and MapLibre adapter: color changes reuse expensive projections. */
export function createCatalogProjectionUpdater(metadata:CatalogConsumerMetadata) {
  let previous:CatalogMapConsumerProjection|null=null;
  return (world:WorldStateV3)=>{
    if(previous?.world===world)return previous;
    previous=previous?(updateCatalogColorProjection(previous,world)?.projection??updateCatalogMapConsumerProjection(previous,world).projection):createCatalogMapConsumerProjection(world,metadata);
    return previous;
  };
}
