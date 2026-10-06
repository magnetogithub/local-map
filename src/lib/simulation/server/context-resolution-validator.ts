import {resolveCatalogRegionEffects,type CatalogRegionIndex} from '../catalog-region';
import {assertWorldGeometryCatalogRefMatches} from '../../world/world-geometry-catalog-ref';
import type {SimulationContextV1} from "../simulation-context";
import {parseTurnResolutionV1, type TurnResolutionV1} from "../turn-resolution";
import {isAuthorityActiveAt} from '../simulation-state-v2';
import {allowsDevelopmentWorldEffect} from '../debug-world-effect';
import {presentationEvidenceFromContext, validatePresentationGrant} from '../presentation-grant-validation';
import {resolveCountryColorIntents} from '../country-color-intent';
import {isConsequenceAvailableAt} from '../consequence-causality';
import type {ScheduledConsequenceV1} from '../narrative-state';

export type ContextValidationResult = Readonly<{
  ok: boolean;
  resolution: TurnResolutionV1 | null;
  issues: readonly Readonly<{code: string; path: string; message: string}>[];
}>;

export type ContextValidationOptions = Readonly<{
  regionIndex?: CatalogRegionIndex;
  debugWorldEffectActionIds?: ReadonlySet<string>;
}>;

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

export function validateResolutionAgainstContext(
  raw: unknown,
  context: SimulationContextV1,
  options: ContextValidationOptions = {},
): ContextValidationResult {
  let resolution: TurnResolutionV1;
  try {
    if(context.regionCatalog&&options.regionIndex?.catalogRef)assertWorldGeometryCatalogRefMatches(context.regionCatalog,options.regionIndex.catalogRef);
    resolution = resolveCountryColorIntents(resolveCatalogRegionEffects(parseTurnResolutionV1(raw),options.regionIndex), context.countryMapColors, context.countryDirectory.map(c=>c.countryId));
  } catch (error) {
    return Object.freeze({
      ok: false,
      resolution: null,
      issues: Object.freeze([{code: "INVALID_SCHEMA", path: "$", message: error instanceof Error ? error.message : "Invalid resolution"}]),
    });
  }
  const issues: {code: string; path: string; message: string}[] = [];
  const add = (code: string, path: string, message: string) => issues.push({code, path, message});
  if (resolution.baseSimulationRevision !== context.revisions.simulation
    || resolution.baseWorldRevision !== context.revisions.world) {
    add("STALE_REVISION", "$", "Resolution revisions do not match the supplied context");
  }
  if (resolution.period.startDate !== context.period.startDate
    || resolution.period.endDate !== context.period.endDate
    || resolution.period.endDate <= resolution.period.startDate) {
    add("INVALID_PERIOD", "period", "Resolution must use the exact advancing context period");
  }
  const actionIds = new Set(context.queuedActions.map((action) => action.actionId));
  const outcomes = new Map<string, number>();
  resolution.playerActionOutcomes.forEach((outcome) =>
    outcomes.set(outcome.actionId, (outcomes.get(outcome.actionId) ?? 0) + 1));
  actionIds.forEach((id) => {
    if (outcomes.get(id) !== 1) add("ACTION_OUTCOME_MISMATCH", "playerActionOutcomes", `Action ${id} requires one outcome`);
  });
  outcomes.forEach((_count, id) => {
    if (!actionIds.has(id)) add("ACTION_OUTCOME_MISMATCH", "playerActionOutcomes", `Unsubmitted action ${id}`);
  });
  const countryIds = new Set(context.countryDirectory.map((country) => country.countryId));
  const territoryOwners = new Map<string, string>();
  context.territoryDirectory.forEach((country) => country.territoryIds.forEach((id) => territoryOwners.set(id, country.countryId)));
  const subdivisionKey = (value: Readonly<{catalogId: string; sourceVersion: string; subdivisionId: string}>) =>
    `${value.catalogId}\u0000${value.sourceVersion}\u0000${value.subdivisionId}`;
  const subdivisions = new Map(context.subdivisions.map((entry) => [subdivisionKey(entry), entry]));
  const eventIndex = new Map(resolution.events.map((event, index) => [event.eventId, index]));
  if (eventIndex.size !== resolution.events.length) add("INVALID_CAUSALITY", "events", "Resolution event IDs must be unique");
  const hasDebugWorldEffectCause = (eventId: string, visited = new Set<string>()): boolean => {
    if (visited.has(eventId)) return false;
    visited.add(eventId);
    const sourceIndex = eventIndex.get(eventId);
    if (sourceIndex === undefined) return false;
    return resolution.events[sourceIndex].causes.some((cause) => {
      if (cause.kind === "queued-action") return options.debugWorldEffectActionIds?.has(cause.id) ?? false;
      if (cause.kind === "resolution-event") return hasDebugWorldEffectCause(cause.id, visited);
      return false;
    });
  };
  const recentEvents = new Map(context.recentEvents
    .map((event) => [field(event, "eventId"), event] as const)
    .filter((entry): entry is readonly [string, unknown] => typeof entry[0] === "string"));
  const consequences = new Map(context.dueConsequences
    .map((entry) => [field(entry, "consequenceId"), entry] as const)
    .filter((entry): entry is readonly [string, unknown] => typeof entry[0] === "string"));
  const knownFactIds = new Set(context.facts.map((fact) => field(fact, "factId")).filter((id): id is string => typeof id === "string"));
  const knownSituationIds = new Set(context.situations.map((situation) => field(situation, "situationId")).filter((id): id is string => typeof id === "string"));
  resolution.factMutations.forEach((mutation) => {
    if (mutation.operation === "upsert") knownFactIds.add(mutation.fact.factId);
  });
  resolution.situationMutations.forEach((mutation) => {
    if (mutation.operation === "upsert") knownSituationIds.add(mutation.situation.situationId);
  });
  const validateCountries = (ids: readonly string[], path: string) => ids.forEach((id) => {
    if (!countryIds.has(id)) add("DANGLING_REFERENCE", path, `Unknown country ${id}`);
  });
  resolution.events.forEach((event, index) => {
    if(event.authorityLifecycle||event.referenceLifecycle)add('INVALID_WORLD_EFFECT',`events[${index}]`,'Host-owned lifecycle events cannot be supplied');
    if (!(context.period.startDate < event.date && event.date <= context.period.endDate)) add("INVALID_EVENT_ORDER", `events[${index}].date`, "Event is outside the turn period");
    if (index > 0 && resolution.events[index - 1].date > event.date) add("INVALID_EVENT_ORDER", `events[${index}]`, "Events are not chronological");
    validateCountries(event.actorCountryIds, `events[${index}].actorCountryIds`);
    event.relatedFactIds.forEach((id) => { if (!knownFactIds.has(id)) add("DANGLING_REFERENCE", `events[${index}].relatedFactIds`, `Unknown fact ${id}`); });
    event.relatedSituationIds.forEach((id) => { if (!knownSituationIds.has(id)) add("DANGLING_REFERENCE", `events[${index}].relatedSituationIds`, `Unknown situation ${id}`); });
    event.causes.forEach((cause) => {
      if (cause.kind === "queued-action" && !actionIds.has(cause.id)) add("DANGLING_REFERENCE", `events[${index}].causes`, `Unknown action ${cause.id}`);
      if (cause.kind === "authoritative-event") {
        const source = recentEvents.get(cause.id);
        if (!source) add("DANGLING_REFERENCE", `events[${index}].causes`, `Unknown event ${cause.id}`);
        else if (typeof field(source, "date") === "string" && (field(source, "date") as string) > event.date) add("INVALID_CAUSALITY", `events[${index}].causes`, "Future event cannot be a cause");
      }
      if (cause.kind === "scheduled-consequence") {
        const consequence = consequences.get(cause.id);
        if (!consequence) add("DANGLING_REFERENCE", `events[${index}].causes`, `Unknown consequence ${cause.id}`);
        else if (!isConsequenceAvailableAt(consequence as ScheduledConsequenceV1,event.date)) add("INVALID_CAUSALITY", `events[${index}].causes`, `Consequence ${cause.id} is unavailable on the event date`);
      }
      if (cause.kind === "resolution-event") {
        const sourceIndex = eventIndex.get(cause.id);
        if (sourceIndex === undefined) add("DANGLING_REFERENCE", `events[${index}].causes`, `Unknown resolution event ${cause.id}`);
        else if (sourceIndex >= index || resolution.events[sourceIndex].date > event.date) add("INVALID_CAUSALITY", `events[${index}].causes`, "Resolution cause must precede its result");
      }
    });
  });
  resolution.playerActionOutcomes.forEach((outcome, index) => {
    if (!eventIndex.has(outcome.evidenceEventId)) add("DANGLING_REFERENCE", `playerActionOutcomes[${index}]`, "Outcome evidence event is missing");
  });
  const requireEvent = (eventId: string, path: string) => {
    if (!eventIndex.has(eventId)) add("DANGLING_REFERENCE", path, `Mutation cause event is missing: ${eventId}`);
  };
  resolution.factMutations.forEach((mutation, index) => {
    const path = `factMutations[${index}]`;
    requireEvent(mutation.causedByEventId, path);
    if (mutation.operation === "end" && !context.facts.some((fact) => field(fact, "factId") === mutation.factId)) add("DANGLING_REFERENCE", path, `Unknown fact ${mutation.factId}`);
    if (mutation.operation === "upsert") {
      validateCountries(mutation.fact.actorCountryIds, path);
      requireEvent(mutation.fact.sourceEventId, `${path}.fact.sourceEventId`);
    }
  });
  resolution.situationMutations.forEach((mutation, index) => {
    const path = `situationMutations[${index}]`;
    requireEvent(mutation.causedByEventId, path);
    if (mutation.operation === "resolve" && !context.situations.some((situation) => field(situation, "situationId") === mutation.situationId)) add("DANGLING_REFERENCE", path, `Unknown situation ${mutation.situationId}`);
    if (mutation.operation === "upsert") {
      validateCountries(mutation.situation.participantCountryIds, path);
      requireEvent(mutation.situation.startedByEventId, `${path}.situation.startedByEventId`);
      requireEvent(mutation.situation.lastUpdatedByEventId, `${path}.situation.lastUpdatedByEventId`);
    }
  });
  resolution.scheduledConsequences.forEach((consequence, index) => {
    const path = `scheduledConsequences[${index}]`;
    requireEvent(consequence.sourceEventId, `${path}.sourceEventId`);
    validateCountries(consequence.actorCountryIds, `${path}.actorCountryIds`);
    if (consequence.situationId !== null && !knownSituationIds.has(consequence.situationId)) add("DANGLING_REFERENCE", `${path}.situationId`, `Unknown situation ${consequence.situationId}`);
  });
  const effectIds = new Set<string>();
  const newCountryRefs = new Set<string>();
  const requireSubdivision = (reference: Readonly<{catalogId: string; sourceVersion: string; subdivisionId: string}>, sourceCountryId: string | null, path: string) => {
    const entry = subdivisions.get(subdivisionKey(reference));
    if (!entry) add("DANGLING_REFERENCE", path, `Unknown subdivision ${reference.subdivisionId}`);
    else if (!entry.materializable) add("INVALID_WORLD_EFFECT", path, `Subdivision ${reference.subdivisionId} is not materializable`);
    else if (sourceCountryId !== null && entry.parentCountryId !== sourceCountryId) add("INVALID_WORLD_EFFECT", path, `Subdivision ${reference.subdivisionId} does not belong to ${sourceCountryId}`);
  };
  resolution.worldEffects.forEach((effect, index) => {
    const path = `worldEffects[${index}]`;
    if (effectIds.has(effect.effectId)) add("INVALID_WORLD_EFFECT", path, `Duplicate effect id ${effect.effectId}`);
    effectIds.add(effect.effectId);
    const event = resolution.events[eventIndex.get(effect.causedByEventId) ?? -1];
    if (!event) {
      add("DANGLING_REFERENCE", path, "Effect cause event is missing");
      return;
    }
    switch (effect.type) {
      case 'territorialAuthority.granted': {
        const a=effect.authority;validateCountries([a.actorCountryId,...a.targetCountryId?[a.targetCountryId]:[]],path);
        const participants=[a.actorCountryId,...a.targetCountryId?[a.targetCountryId]:[]];
        const grounded=event.causes.some(c=>{const prior=c.kind==='authoritative-event'?recentEvents.get(c.id):c.kind==='scheduled-consequence'?consequences.get(c.id):null;return prior&&!field(prior,'authorityLifecycle')&&!field(prior,'referenceLifecycle')&&(c.kind==='scheduled-consequence'||['military','territorial','treaty'].includes(String(field(prior,'outcomeCategory'))))&&participants.every(id=>(field(prior,'actorCountryIds') as string[]).includes(id));})
          ||context.facts.some(f=>field(f,'status')==='active'&&['scenario','conflict-or-war','treaty-or-negotiation','military-or-occupation'].includes(String(field(f,'kind')))&&[a.actorCountryId,...a.targetCountryId?[a.targetCountryId]:[]].every(id=>(field(f,'actorCountryIds') as string[]).includes(id)));
        if(!grounded||a.sourceEventId!==event.eventId||a.validFrom<event.date||!event.actorCountryIds.includes(a.actorCountryId)||!['military','territorial','treaty'].includes(event.outcomeCategory))add('INVALID_WORLD_EFFECT',path,'INVALID_AUTHORITY_GRANT');
        if(context.territorialControlAuthorities?.some(v=>v.id===a.id)||resolution.worldEffects.slice(0,index).some(e=>e.type==='territorialAuthority.granted'&&e.authority.id===a.id))add('INVALID_WORLD_EFFECT',path,'DUPLICATE_AUTHORITY_ID');
        for(const id of a.allowedTerritoryIds)if(!territoryOwners.has(id)&&!options.regionIndex?.hasTerritory(id))add('DANGLING_REFERENCE',path,'Grant territory is absent from the supplied bounded directory');
        break;
      }
      case 'territory.occupy':case 'territory.liberate':case 'territory.transferOwnership': {
        validateCountries([effect.actorCountryId,...effect.targetCountryId?[effect.targetCountryId]:[],...effect.type==='territory.transferOwnership'?[effect.newOwnerCountryId]:[]],path);
        const a=context.territorialControlAuthorities?.find(a=>a.id===effect.authorityId)??resolution.worldEffects.slice(0,index).filter(e=>e.type==='territorialAuthority.granted').find(e=>e.authority.id===effect.authorityId)?.authority;
        const operation=effect.type==='territory.transferOwnership'?'transfer':effect.type.slice('territory.'.length);
        if(a?(a.actorCountryId!==effect.actorCountryId||a.targetCountryId!==effect.targetCountryId||!a.allowedOperations.includes(operation as never)||!isAuthorityActiveAt(a,event.date)||effect.territoryIds.some(id=>!a.allowedTerritoryIds.includes(id as never))):!allowsDevelopmentWorldEffect(hasDebugWorldEffectCause(event.eventId)))add('INVALID_WORLD_EFFECT',path,'TERRITORIAL_AUTHORITY_REQUIRED');
        for(const id of effect.territoryIds)if(!territoryOwners.has(id)&&!options.regionIndex?.hasTerritory(id))add('DANGLING_REFERENCE',path,'Territory is absent from the validated directory/catalog');
        if(!event.actorCountryIds.includes(effect.actorCountryId)||!['military','territorial','treaty'].includes(event.outcomeCategory))add('INVALID_WORLD_EFFECT',path,'INVALID_TERRITORIAL_CAUSE');
        break;
      }
      case 'countries.merged': {
        validateCountries([effect.initiatorCountryId,...effect.absorbedCountryIds],path);
        if(effect.absorbedCountryIds.includes(effect.initiatorCountryId)||!event.actorCountryIds.includes(effect.initiatorCountryId)||event.outcomeCategory!=='treaty'||!event.causes.some(c=>c.kind==='authoritative-event'||c.kind==='scheduled-consequence'))add('INVALID_WORLD_EFFECT',path,'INVALID_MERGE_CAUSE');
        break;
      }
      case 'country.changeMapColor': {
        validateCountries([effect.actorCountryId,effect.countryId],path);
        const authority=context.countryPresentationAuthorities?.find(a=>a.id===effect.authorityId)
          ?? resolution.worldEffects.slice(0,index).filter(e=>e.type==='countryPresentationAuthority.granted').find(e=>e.authority.id===effect.authorityId)?.authority;
        if (!event.actorCountryIds.includes(effect.actorCountryId)) add('INVALID_WORLD_EFFECT',path,'Color actor must participate in the causal event');
        if (!allowsDevelopmentWorldEffect(hasDebugWorldEffectCause(event.eventId)) && (!authority
          || authority.actorCountryId!==effect.actorCountryId || authority.targetCountryId!==effect.countryId
          || !authority.allowedMapColors.includes(effect.mapColor) || !isAuthorityActiveAt(authority,event.date))) {
          add('INVALID_WORLD_EFFECT',path,'PRESENTATION_AUTHORITY_REQUIRED');
        }
        break;
      }
      case 'countryPresentationAuthority.granted': {
        const a=effect.authority;validateCountries([a.actorCountryId,a.targetCountryId],path);
        try {
          const evidence=presentationEvidenceFromContext(context);
          validatePresentationGrant(a,event,{...evidence,authorities:[...evidence.authorities,
            ...resolution.worldEffects.slice(0,index).filter(e=>e.type==='countryPresentationAuthority.granted').map(e=>e.authority)]});
        } catch(error) {add('INVALID_WORLD_EFFECT',path,error instanceof Error?error.message:String(error));}
        break;
      }
      case "country.renamed":
        validateCountries([effect.countryId], path);
        break;
      case "countries.unified": {
        validateCountries(effect.countryIds, path);
        if (newCountryRefs.has(effect.newCountryRef)) add("INVALID_WORLD_EFFECT", path, `Duplicate new country ref ${effect.newCountryRef}`);
        newCountryRefs.add(effect.newCountryRef);
        const grounded = event.outcomeCategory === "treaty" && event.causes.some((cause) => cause.kind === "authoritative-event" || cause.kind === "scheduled-consequence");
        const debugGrounded = hasDebugWorldEffectCause(event.eventId);
        const negotiation = context.facts.some((fact) => field(fact, "status") === "active" && field(fact, "kind") === "treaty-or-negotiation" && effect.countryIds.every((id) => Array.isArray(field(fact, "actorCountryIds")) && (field(fact, "actorCountryIds") as unknown[]).includes(id)));
        if (!grounded && !debugGrounded && !negotiation) add("INVALID_CAUSALITY", path, "Unification lacks a durable treaty or negotiation cause");
        if (debugGrounded) {
          const retiredIds = new Set(effect.countryIds);
          const retainsRetiredCountry = (ids: readonly string[]) => ids.some((id) => retiredIds.has(id));
          if (resolution.factMutations.some((mutation) => mutation.operation === "upsert" && retainsRetiredCountry(mutation.fact.actorCountryIds))) {
            add("INVALID_WORLD_EFFECT", "factMutations", "A debug unification cannot persist facts that reference retiring source countries; keep factMutations empty");
          }
          if (resolution.situationMutations.some((mutation) => mutation.operation === "upsert" && retainsRetiredCountry(mutation.situation.participantCountryIds))) {
            add("INVALID_WORLD_EFFECT", "situationMutations", "A debug unification cannot persist situations that reference retiring source countries; keep situationMutations empty");
          }
          if (resolution.scheduledConsequences.some((consequence) => retainsRetiredCountry(consequence.actorCountryIds))) {
            add("INVALID_WORLD_EFFECT", "scheduledConsequences", "A debug unification cannot schedule consequences for retiring source countries; keep scheduledConsequences empty");
          }
        }
        break;
      }
      case "country.established":
        if (effect.sourceCountryId !== null) validateCountries([effect.sourceCountryId], path);
        effect.territoryIds.forEach((id) => {
          if (!territoryOwners.has(id)) add("DANGLING_REFERENCE", path, `Unknown territory ${id}`);
          else if (effect.sourceCountryId !== null && territoryOwners.get(id) !== effect.sourceCountryId) add("INVALID_WORLD_EFFECT", path, `Territory ${id} is not owned by ${effect.sourceCountryId}`);
        });
        effect.subdivisionRefs.forEach((reference) => requireSubdivision(reference, effect.sourceCountryId, path));
        if (newCountryRefs.has(effect.newCountryRef)) add("INVALID_WORLD_EFFECT", path, `Duplicate new country ref ${effect.newCountryRef}`);
        newCountryRefs.add(effect.newCountryRef);
        break;
      case "country.dissolved":
        validateCountries(effect.successorCountryId === null ? [effect.countryId] : [effect.countryId, effect.successorCountryId], path);
        if (effect.successorCountryId === effect.countryId) add("INVALID_WORLD_EFFECT", path, "A dissolved country cannot succeed itself");
        break;
      case "territories.transferred":
        validateCountries([effect.fromCountryId, effect.toCountryId], path);
        if (effect.fromCountryId === effect.toCountryId) add("INVALID_WORLD_EFFECT", path, "Territory transfer countries must differ");
        effect.territoryIds.forEach((id) => {
          if (!territoryOwners.has(id)) add("DANGLING_REFERENCE", path, `Unknown territory ${id}`);
          else if (territoryOwners.get(id) !== effect.fromCountryId) add("INVALID_WORLD_EFFECT", path, `Territory ${id} is not owned by ${effect.fromCountryId}`);
        });
        if (event.causes.length === 0 || !["treaty", "territorial", "military"].includes(event.outcomeCategory)) add("INVALID_CAUSALITY", path, "Transfer lacks a grounded territorial event");
        break;
      case "country.partitionedBySubdivisions":
        validateCountries([effect.sourceCountryId], path);
        effect.partitions.forEach((partition) => {
          if (newCountryRefs.has(partition.newCountryRef)) add("INVALID_WORLD_EFFECT", path, `Duplicate new country ref ${partition.newCountryRef}`);
          newCountryRefs.add(partition.newCountryRef);
          partition.subdivisionRefs.forEach((reference) => requireSubdivision(reference, effect.sourceCountryId, path));
        });
        break;
    }
  });
  return Object.freeze({
    ok: issues.length === 0,
    resolution: issues.length === 0 ? resolution : null,
    issues: Object.freeze(issues.map((issue) => Object.freeze(issue))),
  });
}
