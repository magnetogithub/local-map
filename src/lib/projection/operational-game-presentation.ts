import type {OperationalCountryPresentation} from '../simulation/operational-game-protocol';
import type {WorldStateV3} from '../world/world-state-v3';
import {createCountrySearchProjection} from './country-search-index-patch';
import {createCountryPanelProjection} from './country-panel-projection';
import type {CountryCapitalFeature} from './country-capital-projection';
import type {ActiveCountryId} from '../world/country-id';

/** Country UI keeps its approved identity/camera/capital seeds; cells use the v3 renderer. */
export function operationalGamePresentation(world: WorldStateV3, presentation: readonly OperationalCountryPresentation[]) {
  const features: CountryCapitalFeature[] = presentation.flatMap(c => c.capital && world.countriesById[c.countryId] ? [{type: 'Feature' as const, id: c.countryId as ActiveCountryId,
    properties: {...c.capital, countryId: c.countryId as ActiveCountryId}, geometry: {type: 'Point' as const, coordinates: [...c.capital.coordinates]}}] : []);
  const capitals = {revision: world.revision, appliedRevision: world.revision, features, featuresByCountryId: new Map(features.map(f => [f.id, f])), omittedCountryIds: world.countryOrder.filter(id => !features.some(f => f.id === id))};
  const panel = createCountryPanelProjection(world, capitals, Object.fromEntries(presentation.map(c => [c.countryId, {...c, countryId: c.countryId as ActiveCountryId}])));
  return {world, search: createCountrySearchProjection(world), panel, capitals, focusByCountryId: Object.fromEntries(presentation.filter(c => world.countriesById[c.countryId]).map(c => [c.countryId, c.focus]))};
}
