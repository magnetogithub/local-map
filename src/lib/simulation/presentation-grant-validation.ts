import {z} from 'zod';
import {countryPresentationAuthoritySchema, MAX_COUNTRY_PRESENTATION_AUTHORITIES, type CountryPresentationAuthority, type SimulationStateV2} from './simulation-state-v2';
import {simulationEventSchema, type SimulationEventV1} from './simulation-event';
import {scheduledConsequenceSchema, type ScheduledConsequenceV1} from './narrative-state';
import type {SimulationContextV1} from './simulation-context';
import {isConsequenceAvailableAt} from './consequence-causality';

// Exact IDs, never a lossy membership approximation. Overflow disables new grants.
export const MAX_PRESENTATION_HISTORY_IDS = 256;
export const presentationHistorySchema = z.strictObject({
  ids: z.array(z.string().min(1).max(128)).max(MAX_PRESENTATION_HISTORY_IDS)
    .refine(ids => ids.every((id, i) => i === 0 || ids[i - 1] < id)),
  complete: z.boolean(),
});
export type PresentationHistory = z.infer<typeof presentationHistorySchema>;
export function presentationHistory(events: readonly SimulationEventV1[]): PresentationHistory {
  const ids = [...new Set(events.flatMap(e => e.authorityLifecycle?.authorityId.startsWith('cpa:')
    ? [e.authorityLifecycle.authorityId] : []))].sort();
  return {ids: ids.slice(0, MAX_PRESENTATION_HISTORY_IDS), complete: ids.length <= MAX_PRESENTATION_HISTORY_IDS};
}
export type PresentationGrantEvidence = Readonly<{
  countryIds: readonly string[];
  authorities: readonly CountryPresentationAuthority[];
  history: PresentationHistory;
  events: readonly SimulationEventV1[];
  consequences: readonly ScheduledConsequenceV1[];
  pendingActions: readonly Readonly<{actionId: string; actorCountryId: string; submittedAtDate: string}>[];
}>;
// The server has only supplied bounded sources; the local adapter has validated full state.
export function presentationEvidenceFromContext(context: SimulationContextV1): PresentationGrantEvidence {
  return {countryIds: context.countryDirectory.map(c => c.countryId), authorities: context.countryPresentationAuthorities ?? [],
    history: context.presentationAuthorityHistory ?? {ids: [], complete: false},
    events: context.recentEvents.map(e => simulationEventSchema.parse(e)),
    consequences: context.dueConsequences.map(c => scheduledConsequenceSchema.parse(c)), pendingActions: context.queuedActions};
}
export function presentationEvidenceFromState(simulation: SimulationStateV2, countryIds: readonly string[]): PresentationGrantEvidence {
  return {countryIds, authorities: Object.values(simulation.countryPresentationAuthoritiesById),
    history: presentationHistory(simulation.eventLog), events: simulation.eventLog, consequences: simulation.scheduledConsequences,
    pendingActions: simulation.queuedActions.filter(a => a.status === 'queued' || a.status === 'resolving')};
}
/** Both adapters use exactly this policy; no debug exception for grants. */
export function validatePresentationGrant(raw: unknown, cause: SimulationEventV1 | undefined, evidence: PresentationGrantEvidence): CountryPresentationAuthority {
  const a = countryPresentationAuthoritySchema.parse(raw);
  if (!evidence.history.complete) throw new Error('INCOMPLETE_PRESENTATION_AUTHORITY_HISTORY');
  if (evidence.authorities.some(p => p.id === a.id) || evidence.history.ids.includes(a.id)) throw new Error('DUPLICATE_PRESENTATION_AUTHORITY');
  if (new Set([...evidence.history.ids, ...evidence.authorities.map(p => p.id)]).size >= MAX_PRESENTATION_HISTORY_IDS)
    throw new Error('PRESENTATION_AUTHORITY_HISTORY_CAP');
  if (!cause || cause.authorityLifecycle || cause.referenceLifecycle || a.sourceEventId !== cause.eventId || a.validFrom !== cause.date
    || a.actorCountryId !== a.targetCountryId || !evidence.countryIds.includes(a.actorCountryId)
    || !cause.actorCountryIds.includes(a.actorCountryId) || !['domestic', 'treaty'].includes(cause.outcomeCategory)) throw new Error('INVALID_PRESENTATION_GRANT');
  const grounded = cause.causes.some(c => {
    if (c.kind === 'authoritative-event') return evidence.events.some(e => e.eventId === c.id
      && !e.authorityLifecycle && !e.referenceLifecycle && e.date <= cause.date);
    if (c.kind === 'scheduled-consequence') return evidence.consequences.some(e => e.consequenceId === c.id
      && isConsequenceAvailableAt(e, cause.date));
    if (c.kind === 'queued-action') return evidence.pendingActions.some(e => e.actionId === c.id
      && e.actorCountryId === a.actorCountryId && e.submittedAtDate <= cause.date);
    return false;
  });
  if (!grounded) throw new Error('UNGROUNDED_PRESENTATION_GRANT');
  if (evidence.authorities.filter(p => p.validTo === null || p.validTo >= cause.date).length >= MAX_COUNTRY_PRESENTATION_AUTHORITIES)
    throw new Error('PRESENTATION_AUTHORITY_COLLECTION_CAP');
  return a;
}
