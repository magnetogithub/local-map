import {describe, expect, it} from "vitest";

import type {ActiveCountryId} from "../world/country-id";
import {
  assertCurrentRevisionPair,
  advanceSimulationClock,
  createSimulationClock,
} from "./simulation-clock";
import {
  createNarrativeStateCollections,
  scheduledConsequenceSchema,
  serializeNarrativeStateCanonical,
  simulationFactSchema,
  validateNarrativeStateReferences,
} from "./narrative-state";
import {
  cancelQueuedPlayerAction,
  queuePlayerAction,
  queuedPlayerActionSchema,
} from "./queued-player-action";
import {validateTurnResolution} from "./semantic-validator";
import type {SimulationStateV1} from "./simulation-state";
import {
  SIMULATION_CONTRACT_VERSION,
  SIMULATION_STATE_SCHEMA_VERSION,
  SimulationContractError,
} from "./simulation-contract-primitives";
import {
  createTurnResolutionFunctionParametersSchema,
  parseTurnResolutionV1,
  TURN_RESOLUTION_LIMITS,
} from "./turn-resolution";
import {worldEffectSchema} from "./world-effect";
import {testWorldState} from "../../stores/world-state-store-v2-fixture";
import {validateResolutionAgainstContext} from "./server/context-resolution-validator";
import type {SimulationContextV1} from "./simulation-context";

const activeCountryId = (value: string) => value as ActiveCountryId;

const seedEvent = {
  eventId: "event.seed-negotiation",
  date: "2019-12-20",
  title: "공동 협상 개시",
  publicNarrative: "양국 대표단이 장기 협상을 시작했습니다.",
  actorCountryIds: ["AAA", "BBB"],
  relatedFactIds: ["fact.negotiation"],
  relatedSituationIds: [],
  causes: [],
  outcomeCategory: "diplomatic" as const,
  significance: "notable" as const,
};

const queuedAction = {
  actionId: "action.1",
  actorCountryId: "AAA",
  submittedAtDate: "2020-01-01",
  text: "공동 협상을 제안한다.",
  visibility: "public" as const,
  status: "queued" as const,
};

const negotiationFact = {
  factId: "fact.negotiation",
  kind: "treaty-or-negotiation" as const,
  actorCountryIds: ["AAA", "BBB"],
  publicSummary: "양국의 제도 통합 협상이 진행 중입니다.",
  startDate: "2019-12-20",
  status: "active" as const,
  sourceEventId: seedEvent.eventId,
};

const simulationState = (withNegotiation = false): SimulationStateV1 => ({
  schemaVersion: SIMULATION_STATE_SCHEMA_VERSION,
  revision: 0,
  currentDate: "2020-01-01",
  turnNumber: 0,
  playerCountryId: activeCountryId("AAA"),
  queuedActions: [queuedAction],
  factsById: withNegotiation ? {[negotiationFact.factId]: negotiationFact} : {},
  factOrder: withNegotiation ? [negotiationFact.factId] : [],
  situationsById: {},
  situationOrder: [],
  scheduledConsequences: [],
  eventLog: withNegotiation ? [seedEvent] : [],
  history: {lastCommittedTurnId: null, committedTurnCount: 0},
});

const turnEvent = (overrides: Record<string, unknown> = {}) => ({
  eventId: "event.turn-1",
  date: "2020-01-15",
  title: "협상 결과 발표",
  publicNarrative: "양국 대표단이 이번 협상의 결과를 발표했습니다.",
  actorCountryIds: ["AAA", "BBB"],
  relatedFactIds: [],
  relatedSituationIds: [],
  causes: [{kind: "queued-action", id: "action.1"}],
  outcomeCategory: "diplomatic",
  significance: "notable",
  ...overrides,
});

const baseResolution = (overrides: Record<string, unknown> = {}) => ({
  contractVersion: SIMULATION_CONTRACT_VERSION,
  baseSimulationRevision: 0,
  baseWorldRevision: 0,
  period: {startDate: "2020-01-01", endDate: "2020-02-01"},
  playerActionOutcomes: [{
    outcomeId: "outcome.1",
    actionId: "action.1",
    status: "delayed",
    evidenceEventId: "event.turn-1",
    summary: "협상이 시작됐지만 아직 결론에 이르지 못했습니다.",
    remainingConditions: ["상대국 의회의 동의가 필요합니다."],
  }],
  events: [turnEvent()],
  factMutations: [],
  situationMutations: [],
  scheduledConsequences: [],
  worldEffects: [],
  advisorSummary: "협상은 진행 중이며 즉시 국경 변화는 없습니다.",
  unresolvedQuestions: ["상대국 의회가 협상안을 지지할지 확인해야 합니다."],
  ...overrides,
});

describe("12-3 SimulationClock and revision pair", () => {
  it("starts from the scenario date and advances monotonically", () => {
    const clock = createSimulationClock();
    expect(clock.currentDate).toBe("2020-01-01");
    expect(advanceSimulationClock(clock, "2020-02-01")).toMatchObject({
      currentDate: "2020-02-01",
      turnNumber: 1,
      revision: 1,
    });
  });

  it("rejects invalid dates, backward progress, excessive jumps, and stale pairs", () => {
    expect(() => createSimulationClock("2020-02-30")).toThrow();
    const clock = createSimulationClock();
    expect(() => advanceSimulationClock(clock, "2019-12-31")).toThrowError(SimulationContractError);
    expect(() => advanceSimulationClock(clock, "2021-01-02")).toThrowError(SimulationContractError);
    expect(() => assertCurrentRevisionPair(
      {simulationRevision: 0, worldRevision: 1},
      {simulationRevision: 1, worldRevision: 1},
    )).toThrowError(SimulationContractError);
  });
});

describe("12-4 QueuedPlayerActionV1", () => {
  it("injects the host player country and leaves unrelated state unchanged", () => {
    const clock = createSimulationClock();
    const world = testWorldState(["AAA", "BBB"]);
    const actions = queuePlayerAction([], {
      actionId: "action.host-1",
      playerCountryId: "AAA",
      submittedAtDate: clock.currentDate,
      text: "무역 협상을 제안한다.",
    });
    expect(actions[0].actorCountryId).toBe("AAA");
    expect(clock).toEqual(createSimulationClock());
    expect(world.revision).toBe(0);
  });

  it("rejects empty/oversized text, duplicate ids, actor mismatch, and resolving cancellation", () => {
    expect(() => queuedPlayerActionSchema.parse({...queuedAction, text: ""})).toThrow();
    expect(() => queuedPlayerActionSchema.parse({...queuedAction, text: "x".repeat(2_001)})).toThrow();
    expect(() => queuePlayerAction([queuedAction], {
      actionId: queuedAction.actionId,
      playerCountryId: "AAA",
      submittedAtDate: "2020-01-01",
      text: "다른 행동",
    })).toThrowError(SimulationContractError);
    expect(() => cancelQueuedPlayerAction([queuedAction], queuedAction.actionId, "BBB"))
      .toThrowError(SimulationContractError);
    expect(() => cancelQueuedPlayerAction(
      [{...queuedAction, status: "resolving"}],
      queuedAction.actionId,
      "AAA",
    )).toThrowError(SimulationContractError);
  });
});

describe("12-5 narrative state contracts", () => {
  const fact = {
    ...negotiationFact,
    actorCountryIds: ["AAA"],
  };
  const situation = {
    situationId: "situation.1",
    type: "diplomatic-process" as const,
    participantCountryIds: ["AAA"],
    stage: "초기 협상",
    stakes: "장기 외교 관계",
    startedByEventId: seedEvent.eventId,
    lastUpdatedByEventId: seedEvent.eventId,
    unresolvedQuestion: "협상이 계속될 것인가?",
    status: "active" as const,
  };
  const consequence = {
    consequenceId: "consequence.1",
    earliestDate: "2020-02-01",
    deadlineDate: "2020-03-01",
    actorCountryIds: ["AAA"],
    situationId: situation.situationId,
    triggerSummary: "협상 진행 상황을 재검토합니다.",
    sourceEventId: seedEvent.eventId,
    status: "scheduled" as const,
  };

  it("creates deterministic ordering and canonical serialization", () => {
    const left = createNarrativeStateCollections({
      facts: [{...fact, factId: "fact.b"}, {...fact, factId: "fact.a"}],
      situations: [situation],
      scheduledConsequences: [
        {...consequence, consequenceId: "consequence.b"},
        {...consequence, consequenceId: "consequence.a"},
      ],
    });
    const right = createNarrativeStateCollections({
      facts: [{...fact, factId: "fact.a"}, {...fact, factId: "fact.b"}],
      situations: [situation],
      scheduledConsequences: [
        {...consequence, consequenceId: "consequence.a"},
        {...consequence, consequenceId: "consequence.b"},
      ],
    });
    expect(left.factOrder).toEqual(["fact.a", "fact.b"]);
    expect(serializeNarrativeStateCanonical(left)).toBe(serializeNarrativeStateCanonical(right));
  });

  it("rejects dangling references, bad date windows, extra fields, and prototype keys", () => {
    const state = createNarrativeStateCollections({
      facts: [fact],
      situations: [situation],
      scheduledConsequences: [consequence],
    });
    expect(() => validateNarrativeStateReferences(state, {
      countryIds: new Set(),
      eventIds: new Set([seedEvent.eventId]),
    })).toThrow(/unknown country/);
    expect(() => validateNarrativeStateReferences(state, {
      countryIds: new Set(["AAA"]),
      eventIds: new Set(),
    })).toThrow(/unknown event/);
    expect(() => scheduledConsequenceSchema.parse({
      ...consequence,
      deadlineDate: "2020-01-01",
    })).toThrow();
    expect(() => simulationFactSchema.parse({...fact, unexpected: true})).toThrow();
    const polluted = JSON.parse(JSON.stringify({...fact}).replace(/}$/, ',"__proto__":{"polluted":true}}'));
    expect(() => createNarrativeStateCollections({
      facts: [polluted],
      situations: [],
      scheduledConsequences: [],
    })).toThrow(/__proto__/);
  });
});

describe("12-6 event and player outcome semantics", () => {
  it("requires one outcome per action and a same-resolution evidence event", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const missingOutcome = validateTurnResolution(
      baseResolution({playerActionOutcomes: []}),
      simulationState(),
      world,
    );
    expect(missingOutcome.issues.some((issue) => issue.code === "ACTION_OUTCOME_MISMATCH")).toBe(true);
    const missingEvidence = validateTurnResolution(
      baseResolution({playerActionOutcomes: [{
        ...baseResolution().playerActionOutcomes[0],
        evidenceEventId: "event.missing",
      }]}),
      simulationState(),
      world,
    );
    expect(missingEvidence.issues.some((issue) => issue.path.includes("evidenceEventId"))).toBe(true);
  });

  it("rejects event date, actor, and future-cause errors", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const stateWithFuture = {
      ...simulationState(),
      eventLog: [{...seedEvent, eventId: "event.future", date: "2020-01-25"}],
    };
    const result = validateTurnResolution(baseResolution({events: [turnEvent({
      date: "2020-01-10",
      actorCountryIds: ["ZZZ"],
      causes: [{kind: "authoritative-event", id: "event.future"}],
    })]}), stateWithFuture, world);
    expect(result.issues.some((issue) => issue.code === "DANGLING_REFERENCE")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "INVALID_CAUSALITY")).toBe(true);
    const outsidePeriod = validateTurnResolution(
      baseResolution({events: [turnEvent({date: "2020-03-01"})]}),
      simulationState(),
      world,
    );
    expect(outsidePeriod.issues.some((issue) => issue.code === "INVALID_EVENT_ORDER")).toBe(true);
  });
});

describe("12-7 semantic WorldEffectV1", () => {
  const validRename = {
    effectId: "effect.rename",
    type: "country.renamed",
    causedByEventId: "event.turn-1",
    countryId: "AAA",
    displayName: "새 이름",
  };

  it("keeps effects semantic and rejects host-owned fields", () => {
    expect(worldEffectSchema.parse(validRename)).toEqual(validRename);
    for (const forbidden of [
      {geometry: {type: "Polygon", coordinates: []}},
      {commandId: "command.1"},
      {expectedRevision: 0},
      {countryIdResult: "NEW"},
      {unknown: true},
    ]) {
      expect(() => worldEffectSchema.parse({...validRename, ...forbidden})).toThrow();
    }
  });
});

describe("12-8 TurnResolutionV1", () => {
  it("parses no-map and map-change turns within explicit limits", () => {
    expect(parseTurnResolutionV1(baseResolution()).worldEffects).toEqual([]);
    const mapTurn = baseResolution({worldEffects: [{
      effectId: "effect.rename",
      type: "country.renamed",
      causedByEventId: "event.turn-1",
      countryId: "AAA",
      displayName: "새 이름",
    }]});
    expect(parseTurnResolutionV1(mapTurn).worldEffects).toHaveLength(1);
    expect(() => parseTurnResolutionV1(baseResolution({
      events: Array.from({length: TURN_RESOLUTION_LIMITS.events + 1}, (_, index) =>
        turnEvent({eventId: `event.${index}`})),
    }))).toThrow();
  });

  it("exports an OpenAI strict-compatible root object without root anyOf", () => {
    const schema = createTurnResolutionFunctionParametersSchema();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema.required).toEqual(expect.arrayContaining([
      "contractVersion",
      "period",
      "events",
      "worldEffects",
    ]));
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const object = value as Record<string, unknown>;
      if (object.type === "object") {
        expect(object.additionalProperties).toBe(false);
        const propertyNames = Object.keys((object.properties ?? {}) as Record<string, unknown>);
        expect(object.required).toEqual(expect.arrayContaining(propertyNames));
      }
      Object.values(object).forEach(visit);
    };
    visit(schema);
  });
});

describe("12-9 causality and semantic validator", () => {
  it("accepts a normal empty-world-effect turn", () => {
    const result = validateTurnResolution(
      baseResolution(),
      simulationState(),
      testWorldState(["AAA", "BBB"]),
    );
    expect(result).toMatchObject({ok: true});
  });

  it("rejects immediate unification without an earlier negotiation", () => {
    const resolution = baseResolution({
      events: [turnEvent({
        title: "통일 선언",
        outcomeCategory: "treaty",
        significance: "transformative",
      })],
      worldEffects: [{
        effectId: "effect.unify",
        type: "countries.unified",
        causedByEventId: "event.turn-1",
        countryIds: ["AAA", "BBB"],
        newCountryRef: "new-country.union",
        displayName: "공동 연방",
      }],
    });
    const result = validateTurnResolution(
      resolution,
      simulationState(),
      testWorldState(["AAA", "BBB"]),
    );
    expect(result.issues.some((issue) => issue.code === "INVALID_CAUSALITY")).toBe(true);
  });

  it("accepts immediate unification only when its causal chain reaches an authorized debug action", () => {
    const resolution = baseResolution({
      events: [
        turnEvent({outcomeCategory: "domestic", significance: "major"}),
        turnEvent({
          eventId: "event.turn-2",
          date: "2020-01-20",
          causes: [{kind: "resolution-event", id: "event.turn-1"}],
          outcomeCategory: "treaty",
          significance: "transformative",
        }),
      ],
      worldEffects: [{
        effectId: "effect.unify",
        type: "countries.unified",
        causedByEventId: "event.turn-2",
        countryIds: ["AAA", "BBB"],
        newCountryRef: "new-country.union",
        displayName: "Debug Union",
      }],
    });
    const state = simulationState();
    const world = testWorldState(["AAA", "BBB"]);

    expect(validateTurnResolution(resolution, state, world).ok).toBe(false);
    expect(validateTurnResolution(resolution, state, world, {
      debugWorldEffectActionIds: new Set(["action.1"]),
    }).ok).toBe(true);
  });

  it("accepts a causally grounded unification", () => {
    const resolution = baseResolution({
      events: [turnEvent({
        title: "통일 조약 비준",
        relatedFactIds: [negotiationFact.factId],
        outcomeCategory: "treaty",
        significance: "transformative",
      })],
      worldEffects: [{
        effectId: "effect.unify",
        type: "countries.unified",
        causedByEventId: "event.turn-1",
        countryIds: ["AAA", "BBB"],
        newCountryRef: "new-country.union",
        displayName: "공동 연방",
      }],
    });
    expect(validateTurnResolution(
      resolution,
      simulationState(true),
      testWorldState(["AAA", "BBB"]),
    )).toMatchObject({ok: true});
  });

  it("rejects originless transfer, unknown references, and unsubmitted player actions", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const territoryId = world.territoryOrder[0];
    const resolution = baseResolution({
      playerActionOutcomes: [{
        ...baseResolution().playerActionOutcomes[0],
        actionId: "action.unsubmitted",
      }],
      events: [turnEvent({causes: [], outcomeCategory: "diplomatic"})],
      worldEffects: [{
        effectId: "effect.transfer",
        type: "territories.transferred",
        causedByEventId: "event.turn-1",
        fromCountryId: "AAA",
        toCountryId: "BBB",
        territoryIds: [territoryId],
      }],
    });
    const result = validateTurnResolution(resolution, simulationState(), world);
    expect(result.issues.some((issue) => issue.code === "ACTION_OUTCOME_MISMATCH")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "INVALID_CAUSALITY")).toBe(true);

    const dangling = validateTurnResolution(
      baseResolution({events: [turnEvent({relatedFactIds: ["fact.missing"]})]}),
      simulationState(),
      world,
    );
    expect(dangling.issues.some((issue) => issue.code === "DANGLING_REFERENCE")).toBe(true);
  });
});

describe("12-R6 server/local validator parity", () => {
  const contextFrom = (simulation: SimulationStateV1): SimulationContextV1 => {
    const world = testWorldState(["AAA", "BBB"]);
    return {
      contextVersion: "simulation-context.v1",
      scenario: {id: "fixture", startDate: simulation.currentDate},
      revisions: {simulation: simulation.revision, world: world.revision},
      period: {startDate: simulation.currentDate, endDate: "2020-02-01"},
      playerCountry: {countryId: "AAA", name: "A"},
      queuedActions: simulation.queuedActions.map(({actionId, actorCountryId, submittedAtDate, text, visibility}) => ({actionId, actorCountryId, submittedAtDate, text, visibility})),
      countries: world.countryOrder.map((countryId) => ({countryId, shortKo: countryId, english: countryId, politicalStatus: "active", territoryCount: world.territoryOrder.filter((id) => world.territoriesById[id].ownerCountryId === countryId).length, territoryIds: world.territoryOrder.filter((id) => world.territoriesById[id].ownerCountryId === countryId)})),
      countryDirectory: world.countryOrder.map((countryId) => ({countryId, shortKo: countryId, english: countryId, searchAliases: [], politicalStatus: "active"})),
      territoryDirectory: world.countryOrder.map((countryId) => ({countryId, territoryIds: world.territoryOrder.filter((id) => world.territoriesById[id].ownerCountryId === countryId)})),
      facts: Object.values(simulation.factsById),
      situations: Object.values(simulation.situationsById),
      dueConsequences: simulation.scheduledConsequences,
      recentEvents: simulation.eventLog,
      subdivisions: [],
      rules: {locale: "ko-KR", capabilities: []},
      metadata: {clipped: []},
    };
  };

  it("has zero server-pass/local-fail fixtures across shared reference rules", () => {
    const simulation = simulationState();
    const world = testWorldState(["AAA", "BBB"]);
    const corpus = [
      baseResolution(),
      baseResolution({events: [turnEvent({actorCountryIds: ["ZZZ"]})]}),
      baseResolution({events: [turnEvent({relatedFactIds: ["fact.missing"]})]}),
      baseResolution({worldEffects: [{effectId: "effect.rename", type: "country.renamed", causedByEventId: "event.turn-1", countryId: "ZZZ", displayName: "Unknown"}]}),
      baseResolution({scheduledConsequences: [{consequenceId: "consequence.new", earliestDate: "2020-02-01", deadlineDate: null, actorCountryIds: ["ZZZ"], situationId: null, triggerSummary: "Later", sourceEventId: "event.turn-1", status: "scheduled"}]}),
    ];
    const mismatches = corpus.filter((fixture) =>
      validateResolutionAgainstContext(fixture, contextFrom(simulation)).ok
      && !validateTurnResolution(fixture, simulation, world).ok);
    expect(mismatches).toEqual([]);
  });
});

