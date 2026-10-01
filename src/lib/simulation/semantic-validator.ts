import type {WorldStateV2} from "../world/world-state-v2";
import type {SimulationFactV1} from "./narrative-state";
import type {SimulationEventV1} from "./simulation-event";
import type {SimulationStateV1} from "./simulation-state";
import {parseTurnResolutionV1, type TurnResolutionV1} from "./turn-resolution";

export type ResolutionValidationIssueCode =
  | "STALE_REVISION"
  | "INVALID_PERIOD"
  | "ACTION_OUTCOME_MISMATCH"
  | "DANGLING_REFERENCE"
  | "INVALID_EVENT_ORDER"
  | "INVALID_CAUSALITY"
  | "INVALID_WORLD_EFFECT";

export type ResolutionValidationIssue = Readonly<{
  code: ResolutionValidationIssueCode;
  path: string;
  message: string;
}>;

export type ResolutionValidationResult = Readonly<{
  ok: boolean;
  resolution: TurnResolutionV1 | null;
  issues: readonly ResolutionValidationIssue[];
}>;

export type ResolutionValidationOptions = Readonly<{
  debugWorldEffectActionIds?: ReadonlySet<string>;
}>;

const keySet = (record: Readonly<Record<string, unknown>>) => new Set(Object.keys(record));

const hasNegotiationFact = (
  facts: readonly SimulationFactV1[],
  countryIds: readonly string[],
) => facts.some((fact) =>
  fact.status === "active"
  && fact.kind === "treaty-or-negotiation"
  && countryIds.every((countryId) => fact.actorCountryIds.includes(countryId)));

export function validateTurnResolution(
  rawResolution: unknown,
  simulation: SimulationStateV1,
  world: WorldStateV2,
  options: ResolutionValidationOptions = {},
): ResolutionValidationResult {
  const parsed = parseTurnResolutionV1(rawResolution);
  const issues: ResolutionValidationIssue[] = [];
  const add = (code: ResolutionValidationIssueCode, path: string, message: string) => {
    issues.push(Object.freeze({code, path, message}));
  };

  if (
    parsed.baseSimulationRevision !== simulation.revision
    || parsed.baseWorldRevision !== world.revision
  ) {
    add("STALE_REVISION", "$", "Resolution base revisions do not match current state");
  }
  if (parsed.period.startDate !== simulation.currentDate || parsed.period.endDate <= parsed.period.startDate) {
    add("INVALID_PERIOD", "period", "Resolution period must advance from the current date");
  }

  const pendingActions = simulation.queuedActions.filter((action) =>
    action.status === "queued" || action.status === "resolving");
  const outcomesByAction = new Map<string, number>();
  for (const outcome of parsed.playerActionOutcomes) {
    outcomesByAction.set(outcome.actionId, (outcomesByAction.get(outcome.actionId) ?? 0) + 1);
  }
  for (const action of pendingActions) {
    if (outcomesByAction.get(action.actionId) !== 1) {
      add(
        "ACTION_OUTCOME_MISMATCH",
        "playerActionOutcomes",
        `Queued action ${action.actionId} must have exactly one outcome`,
      );
    }
  }
  const pendingActionIds = new Set(pendingActions.map((action) => action.actionId));
  for (const actionId of outcomesByAction.keys()) {
    if (!pendingActionIds.has(actionId)) {
      add(
        "ACTION_OUTCOME_MISMATCH",
        "playerActionOutcomes",
        `Outcome references an unsubmitted action ${actionId}`,
      );
    }
  }

  const activeCountryIds = keySet(world.countriesById);
  const territoryIds = keySet(world.territoriesById);
  const authoritativeEvents = new Map(simulation.eventLog.map((event) => [event.eventId, event]));
  const resolutionEvents = new Map(parsed.events.map((event, index) => [event.eventId, {event, index}]));
  if (resolutionEvents.size !== parsed.events.length) {
    add("INVALID_CAUSALITY", "events", "Resolution event IDs must be unique");
  }
  const hasDebugWorldEffectCause = (eventId: string, visited = new Set<string>()): boolean => {
    if (visited.has(eventId)) return false;
    visited.add(eventId);
    const source = resolutionEvents.get(eventId)?.event;
    if (!source) return false;
    return source.causes.some((reference) => {
      if (reference.kind === "queued-action") return options.debugWorldEffectActionIds?.has(reference.id) ?? false;
      if (reference.kind === "resolution-event") return hasDebugWorldEffectCause(reference.id, visited);
      return false;
    });
  };
  const consequenceById = new Map(
    simulation.scheduledConsequences.map((consequence) => [consequence.consequenceId, consequence]),
  );
  const knownFactIds = new Set([...simulation.factOrder]);
  const knownSituationIds = new Set([...simulation.situationOrder]);
  for (const mutation of parsed.factMutations) {
    if (mutation.operation === "upsert") knownFactIds.add(mutation.fact.factId);
  }
  for (const mutation of parsed.situationMutations) {
    if (mutation.operation === "upsert") knownSituationIds.add(mutation.situation.situationId);
  }

  const validateCountries = (ids: readonly string[], path: string) => {
    for (const id of ids) {
      if (!activeCountryIds.has(id)) add("DANGLING_REFERENCE", path, `Unknown country ${id}`);
    }
  };

  parsed.events.forEach((event, index) => {
    const path = `events[${index}]`;
    if (!(parsed.period.startDate < event.date && event.date <= parsed.period.endDate)) {
      add("INVALID_EVENT_ORDER", `${path}.date`, `Event ${event.eventId} is outside the turn period`);
    }
    if (index > 0 && parsed.events[index - 1].date > event.date) {
      add("INVALID_EVENT_ORDER", path, "Events must use stable chronological order");
    }
    validateCountries(event.actorCountryIds, `${path}.actorCountryIds`);
    for (const factId of event.relatedFactIds) {
      if (!knownFactIds.has(factId)) add("DANGLING_REFERENCE", path, `Unknown fact ${factId}`);
    }
    for (const situationId of event.relatedSituationIds) {
      if (!knownSituationIds.has(situationId)) {
        add("DANGLING_REFERENCE", path, `Unknown situation ${situationId}`);
      }
    }
    for (const cause of event.causes) {
      if (cause.kind === "authoritative-event") {
        const source = authoritativeEvents.get(cause.id);
        if (!source) add("DANGLING_REFERENCE", path, `Unknown authoritative event ${cause.id}`);
        else if (source.date > event.date) add("INVALID_CAUSALITY", path, "Future event cannot be a cause");
      } else if (cause.kind === "resolution-event") {
        const source = resolutionEvents.get(cause.id);
        if (!source) add("DANGLING_REFERENCE", path, `Unknown resolution event ${cause.id}`);
        else if (source.index >= index || source.event.date > event.date) {
          add("INVALID_CAUSALITY", path, "Resolution cause must be an earlier event");
        }
      } else if (cause.kind === "queued-action") {
        if (!pendingActionIds.has(cause.id)) add("DANGLING_REFERENCE", path, `Unknown action ${cause.id}`);
      } else {
        const consequence = consequenceById.get(cause.id);
        if (!consequence) add("DANGLING_REFERENCE", path, `Unknown consequence ${cause.id}`);
        else if (consequence.earliestDate > parsed.period.endDate) {
          add("INVALID_CAUSALITY", path, `Consequence ${cause.id} is not due`);
        }
      }
    }
  });

  const eventIds = new Set(parsed.events.map((event) => event.eventId));
  parsed.playerActionOutcomes.forEach((outcome, index) => {
    if (!eventIds.has(outcome.evidenceEventId)) {
      add(
        "DANGLING_REFERENCE",
        `playerActionOutcomes[${index}].evidenceEventId`,
        `Outcome evidence event is missing: ${outcome.evidenceEventId}`,
      );
    }
  });

  const validateMutationCause = (eventId: string, path: string) => {
    if (!eventIds.has(eventId)) add("DANGLING_REFERENCE", path, `Mutation cause event is missing: ${eventId}`);
  };
  parsed.factMutations.forEach((mutation, index) => {
    validateMutationCause(mutation.causedByEventId, `factMutations[${index}]`);
    if (mutation.operation === "end" && !simulation.factsById[mutation.factId]) {
      add("DANGLING_REFERENCE", `factMutations[${index}]`, `Unknown fact ${mutation.factId}`);
    }
    if (mutation.operation === "upsert") {
      validateCountries(mutation.fact.actorCountryIds, `factMutations[${index}]`);
      validateMutationCause(mutation.fact.sourceEventId, `factMutations[${index}].fact.sourceEventId`);
    }
  });
  parsed.situationMutations.forEach((mutation, index) => {
    validateMutationCause(mutation.causedByEventId, `situationMutations[${index}]`);
    if (mutation.operation === "resolve" && !simulation.situationsById[mutation.situationId]) {
      add("DANGLING_REFERENCE", `situationMutations[${index}]`, `Unknown situation ${mutation.situationId}`);
    }
    if (mutation.operation === "upsert") {
      validateCountries(mutation.situation.participantCountryIds, `situationMutations[${index}]`);
      validateMutationCause(mutation.situation.startedByEventId, `situationMutations[${index}].situation.startedByEventId`);
      validateMutationCause(mutation.situation.lastUpdatedByEventId, `situationMutations[${index}].situation.lastUpdatedByEventId`);
    }
  });

  parsed.scheduledConsequences.forEach((consequence, index) => {
    if (!eventIds.has(consequence.sourceEventId)) {
      add("DANGLING_REFERENCE", `scheduledConsequences[${index}]`, "Consequence source event is missing");
    }
    validateCountries(consequence.actorCountryIds, `scheduledConsequences[${index}]`);
    if (consequence.situationId !== null && !knownSituationIds.has(consequence.situationId)) {
      add("DANGLING_REFERENCE", `scheduledConsequences[${index}]`, "Consequence situation is missing");
    }
  });

  const effectIds = new Set<string>();
  const newCountryRefs = new Set<string>();
  parsed.worldEffects.forEach((effect, index) => {
    const path = `worldEffects[${index}]`;
    if (effectIds.has(effect.effectId)) add("INVALID_WORLD_EFFECT", path, "Duplicate effect id");
    effectIds.add(effect.effectId);
    const cause = resolutionEvents.get(effect.causedByEventId)?.event;
    if (!cause) {
      add("DANGLING_REFERENCE", path, `Effect cause event is missing: ${effect.causedByEventId}`);
      return;
    }

    switch (effect.type) {
      case "country.renamed":
        validateCountries([effect.countryId], path);
        break;
      case "countries.unified": {
        validateCountries(effect.countryIds, path);
        if (newCountryRefs.has(effect.newCountryRef)) {
          add("INVALID_WORLD_EFFECT", path, `Duplicate new country ref ${effect.newCountryRef}`);
        }
        newCountryRefs.add(effect.newCountryRef);
        const durableCause = cause.causes.some((reference) =>
          reference.kind === "authoritative-event" || reference.kind === "scheduled-consequence");
        const debugGrounded = hasDebugWorldEffectCause(cause.eventId);
        const negotiationFact = hasNegotiationFact(Object.values(simulation.factsById), effect.countryIds);
        if (!debugGrounded && (cause.outcomeCategory !== "treaty" || (!durableCause && !negotiationFact))) {
          add(
            "INVALID_CAUSALITY",
            path,
            "Unification requires a treaty event grounded in an earlier negotiation or due consequence",
          );
        }
        break;
      }
      case "country.established":
        if (effect.sourceCountryId !== null) validateCountries([effect.sourceCountryId], path);
        for (const territoryId of effect.territoryIds) {
          if (!territoryIds.has(territoryId)) add("DANGLING_REFERENCE", path, `Unknown territory ${territoryId}`);
        }
        if (newCountryRefs.has(effect.newCountryRef)) {
          add("INVALID_WORLD_EFFECT", path, `Duplicate new country ref ${effect.newCountryRef}`);
        }
        newCountryRefs.add(effect.newCountryRef);
        break;
      case "country.dissolved":
        validateCountries(
          effect.successorCountryId === null
            ? [effect.countryId]
            : [effect.countryId, effect.successorCountryId],
          path,
        );
        if (effect.successorCountryId === effect.countryId) {
          add("INVALID_WORLD_EFFECT", path, "A dissolved country cannot succeed itself");
        }
        break;
      case "territories.transferred":
        validateCountries([effect.fromCountryId, effect.toCountryId], path);
        if (effect.fromCountryId === effect.toCountryId) {
          add("INVALID_WORLD_EFFECT", path, "Territory transfer countries must differ");
        }
        for (const territoryId of effect.territoryIds) {
          const territory = world.territoriesById[territoryId];
          if (!territory) add("DANGLING_REFERENCE", path, `Unknown territory ${territoryId}`);
          else if (territory.ownerCountryId !== effect.fromCountryId) {
            add("INVALID_WORLD_EFFECT", path, `Territory ${territoryId} is not owned by ${effect.fromCountryId}`);
          }
        }
        if (
          cause.causes.length === 0
          || !["territorial", "treaty", "military"].includes(cause.outcomeCategory)
        ) {
          add("INVALID_CAUSALITY", path, "Territory transfer requires a grounded territorial outcome");
        }
        break;
      case "country.partitionedBySubdivisions":
        validateCountries([effect.sourceCountryId], path);
        for (const partition of effect.partitions) {
          if (newCountryRefs.has(partition.newCountryRef)) {
            add("INVALID_WORLD_EFFECT", path, `Duplicate new country ref ${partition.newCountryRef}`);
          }
          newCountryRefs.add(partition.newCountryRef);
        }
        break;
    }
  });

  return Object.freeze({
    ok: issues.length === 0,
    resolution: issues.length === 0 ? parsed : null,
    issues: Object.freeze(issues),
  });
}

export function assertValidTurnResolution(
  rawResolution: unknown,
  simulation: SimulationStateV1,
  world: WorldStateV2,
): TurnResolutionV1 {
  const result = validateTurnResolution(rawResolution, simulation, world);
  if (!result.ok || result.resolution === null) {
    const first = result.issues[0];
    throw new Error(first ? `${first.code} at ${first.path}: ${first.message}` : "Invalid resolution");
  }
  return result.resolution;
}

export const resolutionEventById = (
  resolution: TurnResolutionV1,
  eventId: string,
): SimulationEventV1 | null => resolution.events.find((event) => event.eventId === eventId) ?? null;

