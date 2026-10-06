import {createSimulationStateV2, type SimulationStateV2} from './simulation-state-v2';
import type {TurnResolutionV1} from './turn-resolution';
import type {WorldStateV3} from '../world/world-state-v3';
import {presentationEvidenceFromState, validatePresentationGrant} from './presentation-grant-validation';

/** Pure preparation for a bounded presentation mandate; published only with the atomic plan. */
export function prepareCountryColorAuthorities(simulation: SimulationStateV2, world: WorldStateV3, resolution: TurnResolutionV1, date=simulation.currentDate) {
  const record = {...simulation.countryPresentationAuthoritiesById};
  const grants = resolution.worldEffects.filter(e => e.type === 'countryPresentationAuthority.granted');
  const evidence = presentationEvidenceFromState(simulation, world.countryOrder);
  for (const effect of grants) {
    const cause = resolution.events.find(e => e.eventId === effect.causedByEventId);
    const a = validatePresentationGrant(effect.authority, cause, {...evidence, authorities: Object.values(record)});
    record[a.id] = a;
  }
  const events = new Map([...simulation.eventLog,...resolution.events.filter(e=>e.date<=date)].map(e=>[e.eventId,e]));
  const activeTerritorial=Object.fromEntries(Object.entries(simulation.territorialControlAuthoritiesById).filter(([,a])=>a.validTo===null||a.validTo>=date));
  const activePresentation=Object.fromEntries(Object.entries(record).filter(([,a])=>a.validTo===null||a.validTo>=date));
  return grants.length ? createSimulationStateV2({...simulation,
    currentDate:date,territorialControlAuthoritiesById:activeTerritorial,territorialControlAuthorityOrder:Object.keys(activeTerritorial).sort(),
    countryPresentationAuthoritiesById:activePresentation,countryPresentationAuthorityOrder:Object.keys(activePresentation).sort(),
    eventLog:[...events.values()].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0)},world) : simulation;
}
