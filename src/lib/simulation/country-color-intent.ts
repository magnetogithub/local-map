import {allocateCountryMapColor} from '../world/country-map-color';
import {sha256Hex} from '../world/sha256';
import {parseTurnResolutionV1, type TurnResolutionV1} from './turn-resolution';

/** Allocation conveys no authority: normal validation must approve the single-color
 * grant and its matching effect. Always select against the unchanged base palette. */
export function resolveCountryColorIntents(resolution: TurnResolutionV1,
  palette: readonly Readonly<{countryId: string; mapColor: string}>[] | undefined,
  countryIds: readonly string[]): TurnResolutionV1 {
  if (!resolution.worldEffects.some(e => e.type === 'country.chooseMapColor')) return resolution;
  if (!palette || palette.length !== countryIds.length || new Set(palette.map(c => c.countryId)).size !== countryIds.length
    || countryIds.some(id => !palette.some(c => c.countryId === id))) throw new Error('INCOMPLETE_COUNTRY_COLOR_PALETTE');
  const worldEffects = resolution.worldEffects.flatMap(effect => {
    if (effect.type !== 'country.chooseMapColor') return [effect];
    const a = effect.authority;
    const mapColor = allocateCountryMapColor(a.targetCountryId, palette.map(c => c.mapColor), effect.requestedMapColor ?? undefined);
    const key = sha256Hex(new TextEncoder().encode(`presentation-intent.v1\0${effect.effectId}`)).slice(0, 52);
    return [{effectId: `color-grant:${key}`, causedByEventId: effect.causedByEventId,
      type: 'countryPresentationAuthority.granted' as const, authority: {...a, allowedMapColors: [mapColor]}},
    {effectId: effect.effectId, causedByEventId: effect.causedByEventId, type: 'country.changeMapColor' as const,
      actorCountryId: a.actorCountryId, countryId: a.targetCountryId, mapColor, authorityId: a.id}];
  });
  // Keep the existing final effect cap and strict stored color/date policies.
  return parseTurnResolutionV1({...resolution, worldEffects});
}
