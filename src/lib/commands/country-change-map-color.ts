import {z} from 'zod';
import {createMapCommandV2Schema} from './map-command-v2';
import {countryIdSchema, isoCalendarDateSchema} from '../simulation/simulation-contract-primitives';
import {authorityMapColorSchema, countryPresentationAuthorityIdSchema, isAuthorityActiveAt,
  type SimulationStateV2} from '../simulation/simulation-state-v2';
import type {WorldStateV3} from '../world/world-state-v3';
import {allowsDevelopmentWorldEffect} from '../simulation/debug-world-effect';

export const countryChangeMapColorCommandSchema = createMapCommandV2Schema('country.changeMapColor', z.strictObject({
  actorCountryId: countryIdSchema, countryId: countryIdSchema,
  mapColor: authorityMapColorSchema, authorityId: countryPresentationAuthorityIdSchema,
}));
export type CountryChangeMapColorCommand = z.infer<typeof countryChangeMapColorCommandSchema>;
export function validateCountryChangeMapColorCommand(raw: unknown, world: WorldStateV3,
  simulation: SimulationStateV2, options: {date?: string; debugDirective?: boolean} = {}): CountryChangeMapColorCommand {
  const command = countryChangeMapColorCommandSchema.parse(raw), p = command.payload;
  const date = isoCalendarDateSchema.parse(options.date ?? simulation.currentDate);
  if (date < simulation.currentDate) throw new Error('INVALID_OPERATION_DATE');
  if (command.expectedRevision !== world.revision) throw new Error('STALE_REVISION');
  for (const id of [p.actorCountryId, p.countryId]) {
    if (!Object.hasOwn(world.countriesById, id)) throw new Error('INACTIVE_COUNTRY');
  }
  if (!allowsDevelopmentWorldEffect(options.debugDirective === true)) {
    const authority = simulation.countryPresentationAuthoritiesById[p.authorityId];
    if (!authority || authority.actorCountryId !== p.actorCountryId || authority.targetCountryId !== p.countryId
      || !authority.allowedMapColors.includes(p.mapColor)
      || !isAuthorityActiveAt(authority, date)
      || !simulation.eventLog.some(e => e.eventId === authority.sourceEventId)) throw new Error('PRESENTATION_AUTHORITY_REQUIRED');
  }
  return command;
}
