import {MAX_COMMANDS_PER_BATCH} from '../commands/command-batch-v2';
import {validateCountryChangeMapColorCommand} from '../commands/country-change-map-color';
import {createCountryEntityV3, type CountryEntityV3} from '../world/country-entity-v3';
import type {WorldStateV3} from '../world/world-state-v3';
import type {SimulationStateV2} from '../simulation/simulation-state-v2';

/** Pure bounded planning port. Merge callers pass the surviving initiator world/pair. */
export function planCountryMapColors(input: {world: WorldStateV3; simulation: SimulationStateV2;
  commands: readonly unknown[]; date?: string; debugDirective?: boolean}) {
  if (input.commands.length > MAX_COMMANDS_PER_BATCH) throw new Error('COMMAND_CAP_EXCEEDED');
  const countries: Record<string, CountryEntityV3> = {}, commandIds = new Set<string>();
  for (const raw of input.commands) {
    const command = validateCountryChangeMapColorCommand(raw, input.world, input.simulation, input);
    if (commandIds.has(command.commandId)) throw new Error('DUPLICATE_COMMAND_ID');
    commandIds.add(command.commandId);
    const {countryId, mapColor} = command.payload, before = countries[countryId] ?? input.world.countriesById[countryId];
    countries[countryId] = createCountryEntityV3({...before, mapColor});
  }
  const changedCountryIds = Object.keys(countries).filter(id => countries[id].mapColor !== input.world.countriesById[id].mapColor).sort();
  const changed = new Set(changedCountryIds);
  const affectedTerritoryIds = input.world.territoryOrder.filter(id => {
    const t = input.world.territoriesById[id];
    return changed.has(t.ownerCountryId ?? '') || changed.has(t.controllerCountryId ?? '');
  });
  return Object.freeze({countries: Object.freeze(Object.fromEntries(changedCountryIds.map(id => [id, countries[id]]))),
    changedCountryIds: Object.freeze(changedCountryIds), affectedTerritoryIds: Object.freeze(affectedTerritoryIds),
    commandCount: input.commands.length});
}
