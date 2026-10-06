import {describe, expect, it} from "vitest";

import {createCommandUiDemoWorldState} from "../planning/command-ui-runtime";
import {checkpointWorldContentHash} from "../planning/history-persistence-checkpoint";
import {canonicalStringify} from "../world/canonical-serializer";
import {createWorldStateV2} from "../world/world-state-v2";
import type {RetiredCountryId} from "../world/country-id";
import {createAtomicTurnRuntime} from "./atomic-turn-runtime";
import {createInitialSimulationState} from "./initial-simulation-state";
import {createResolvedTurnPlan, type ResolvedTurnPlan} from "./resolved-turn-plan";
import {createSimulationStateV1} from "./simulation-state";
import {
  countryPresentationAuthoritySchema,
  countryPresentationAuthorityIdSchema,
  createSimulationStateV2,
  deserializeSimulationStateV2,
  isAuthorityActiveAt,
  migrateSimulationStateV1ToV2,
  parseSimulationStateV2,
  serializeSimulationStateV2,
  simulationStateV2ContentHash,
  territorialControlAuthoritySchema,
  territorialControlAuthorityIdSchema,
  type SimulationStateV2,
} from "./simulation-state-v2";

const sourceEvent = {
  eventId: "event.authority", date: "2020-01-01", title: "Bounded mandate",
  publicNarrative: "A verified mandate was issued.", actorCountryIds: ["AAA", "BBB"],
  relatedFactIds: [], relatedSituationIds: [], causes: [],
  outcomeCategory: "territorial", significance: "notable",
};

const fixture = () => {
  const world = createCommandUiDemoWorldState();
  const legacy = createSimulationStateV1({
    ...createInitialSimulationState(world, "AAA"), eventLog: [sourceEvent],
    queuedActions: [{actionId: "action.1", actorCountryId: "AAA", submittedAtDate: "2020-01-01",
      text: "Negotiate a mandate", visibility: "public", status: "queued"}],
    factsById: {"fact.1": {factId: "fact.1", kind: "territorial-claim",
      actorCountryIds: ["AAA"], publicSummary: "Mandate recorded", startDate: "2020-01-01",
      status: "active", sourceEventId: sourceEvent.eventId}}, factOrder: ["fact.1"],
    situationsById: {"situation.1": {situationId: "situation.1", type: "war",
      participantCountryIds: ["AAA", "BBB"], stage: "Mandate", stakes: "Territory",
      startedByEventId: sourceEvent.eventId, lastUpdatedByEventId: sourceEvent.eventId,
      unresolvedQuestion: "Will it end?", status: "active"}}, situationOrder: ["situation.1"],
    scheduledConsequences: [{consequenceId: "consequence.1", earliestDate: "2020-02-01",
      deadlineDate: null, actorCountryIds: ["AAA"], situationId: "situation.1",
      triggerSummary: "Review mandate", sourceEventId: sourceEvent.eventId, status: "scheduled"}],
    history: {lastCommittedTurnId: "turn.previous", committedTurnCount: 1},
  }, world);
  const empty = migrateSimulationStateV1ToV2(legacy, world);
  const territorial = {
    id: "tca:mandate", actorCountryId: "AAA", targetCountryId: "BBB",
    allowedTerritoryIds: [world.territoryOrder[0]], allowedOperations: ["liberate", "occupy", "transfer"],
    validFrom: "2020-01-01", validTo: "2020-03-01", sourceEventId: sourceEvent.eventId,
  };
  const presentation = {
    id: "cpa:mandate", actorCountryId: "AAA", targetCountryId: "AAA",
    allowedMapColors: ["#CC0000", "#FFFFFF"], validFrom: "2020-01-01", validTo: null,
    sourceEventId: sourceEvent.eventId,
  };
  const input = {
    ...empty, territorialControlAuthoritiesById: {[territorial.id]: territorial},
    territorialControlAuthorityOrder: [territorial.id],
    countryPresentationAuthoritiesById: {[presentation.id]: presentation},
    countryPresentationAuthorityOrder: [presentation.id],
  };
  return {world, legacy, empty, territorial, presentation, input,
    state: createSimulationStateV2(input, world)};
};

describe("14-4 Simulation V2 migration and strict authority schema", () => {
  it("preserves canonical authority ID prefixes, characters, and the 64-character bound", () => {
    for (const [prefix, schema] of [["tca", territorialControlAuthorityIdSchema], ["cpa", countryPresentationAuthorityIdSchema]] as const) {
      expect(schema.parse(`${prefix}:A._:-9`)).toBe(`${prefix}:A._:-9`);
      expect(schema.safeParse(`${prefix}:${"a".repeat(60)}`).success).toBe(true);
      for (const invalid of ["", `${prefix}:`, `${prefix}:_bad`, `${prefix}:한글`, `${prefix}:has space`, `${prefix}:${"a".repeat(61)}`, `${prefix === "tca" ? "cpa" : "tca"}:wrong`]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    }
  });

  it("preserves every V1 field and explicitly initializes all four empty collections", () => {
    const {world, legacy, empty} = fixture();
    const {schemaVersion, territorialControlAuthoritiesById, territorialControlAuthorityOrder,
      countryPresentationAuthoritiesById, countryPresentationAuthorityOrder, ...preserved} = empty;
    expect(schemaVersion).toBe(2);
    expect(preserved).toEqual(
      Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== "schemaVersion")));
    expect([territorialControlAuthoritiesById, territorialControlAuthorityOrder,
      countryPresentationAuthoritiesById, countryPresentationAuthorityOrder]).toEqual([{}, [], {}, []]);
    expect(legacy.schemaVersion).toBe(1);
    expect(createInitialSimulationState(world, "AAA").schemaVersion).toBe(1);
    expect(migrateSimulationStateV1ToV2(legacy, world)).toEqual(empty);
    expect(() => migrateSimulationStateV1ToV2(empty, world)).toThrow();
  });

  it("strictly snapshots and deeply freezes caller-owned authority data", () => {
    const {input, state} = fixture();
    input.territorialControlAuthoritiesById["tca:mandate"].allowedTerritoryIds.length = 0;
    input.countryPresentationAuthorityOrder.length = 0;
    expect(state.territorialControlAuthoritiesById["tca:mandate"].allowedTerritoryIds).toHaveLength(1);
    expect(state.countryPresentationAuthorityOrder).toEqual(["cpa:mandate"]);
    expect(Object.isFrozen(state.territorialControlAuthoritiesById["tca:mandate"].allowedTerritoryIds)).toBe(true);
    expect(Object.isFrozen(state.countryPresentationAuthoritiesById["cpa:mandate"])).toBe(true);
  });

  it.each(["2020-02-30", "2019-02-29", "2020-13-01", "2020-1-01", "2020-01-01T00:00:00Z"])(
    "rejects invalid calendar date %s in both authorities and state", (date) => {
      const {territorial, presentation, input} = fixture();
      expect(() => territorialControlAuthoritySchema.parse({...territorial, validFrom: date})).toThrow();
      expect(() => countryPresentationAuthoritySchema.parse({...presentation, validTo: date})).toThrow();
      expect(() => parseSimulationStateV2({...input, currentDate: date})).toThrow();
    },
  );

  it("enforces date ranges, inclusive activity, future permissions, and no expired permissions", () => {
    const {territorial, presentation, input, world} = fixture();
    expect(() => territorialControlAuthoritySchema.parse({...territorial, validTo: "2019-12-31"})).toThrow();
    expect(() => countryPresentationAuthoritySchema.parse({...presentation, validTo: "2019-12-31"})).toThrow();
    expect(isAuthorityActiveAt(territorial, "2020-01-01")).toBe(true);
    expect(isAuthorityActiveAt(territorial, "2020-03-01")).toBe(true);
    expect(isAuthorityActiveAt(territorial, "2020-03-02")).toBe(false);
    expect(isAuthorityActiveAt(territorial, "2019-12-31")).toBe(false);
    expect(isAuthorityActiveAt(presentation, "2099-12-31")).toBe(true);
    expect(() => createSimulationStateV2({...input, currentDate: "2020-03-02"}, world)).toThrow(/Expired/);
    const future = {...territorial, validFrom: "2020-02-01"};
    expect(() => createSimulationStateV2({...input,
      territorialControlAuthoritiesById: {[future.id]: future}}, world)).not.toThrow();
    expect(isAuthorityActiveAt(future, input.currentDate)).toBe(false);
    expect(() => isAuthorityActiveAt(territorial, "2020-02-30")).toThrow();
  });

  it.each(["territorialControlAuthorityOrder", "countryPresentationAuthorityOrder"] as const)(
    "rejects missing, duplicate, unknown, and unsorted %s", (field) => {
      const {input} = fixture();
      const original = input[field][0];
      for (const order of [[], [original, original], [original.replace("mandate", "missing")]]) {
        expect(() => parseSimulationStateV2({...input, [field]: order})).toThrow();
      }
      const territorial = field === "territorialControlAuthorityOrder";
      const recordField = territorial ? "territorialControlAuthoritiesById" : "countryPresentationAuthoritiesById";
      const record = input[recordField];
      const otherId = original.replace("mandate", "z");
      const other = {...Object.values(record)[0], id: otherId};
      expect(() => parseSimulationStateV2({...input, [recordField]: {...record, [otherId]: other},
        [field]: [otherId, original]})).toThrow(/canonical order/);
    },
  );

  it("rejects wrong prefixes, key/id mismatch, excessive IDs, unknown fields, and prototype keys", () => {
    const {input, territorial, presentation} = fixture();
    for (const id of ["cpa:mandate", "tca:", "tca: bad", `tca:${"a".repeat(61)}`]) {
      expect(() => territorialControlAuthoritySchema.parse({...territorial, id})).toThrow();
    }
    expect(() => countryPresentationAuthoritySchema.parse({...presentation, id: "tca:mandate"})).toThrow();
    expect(() => parseSimulationStateV2({...input,
      territorialControlAuthoritiesById: {"tca:mandate": {...territorial, id: "tca:other"}}})).toThrow(/key/);
    expect(() => parseSimulationStateV2({...input, extra: true})).toThrow();
    expect(() => territorialControlAuthoritySchema.parse({...territorial, debug: true})).toThrow();
    const polluted = JSON.parse(JSON.stringify(input));
    Object.defineProperty(polluted.countryPresentationAuthoritiesById, "__proto__",
      {value: presentation, enumerable: true});
    expect(() => parseSimulationStateV2(polluted)).toThrow(/forbidden/);
    expect(() => parseSimulationStateV2({...input,
      territorialControlAuthoritiesById: Object.create({"tca:mandate": territorial})})).toThrow(/plain/);
    const hidden = {...input};
    Object.defineProperty(hidden, "extra", {value: true, enumerable: false});
    expect(() => parseSimulationStateV2(hidden)).toThrow(/enumerable/);
    const accessor = {...input};
    Object.defineProperty(accessor, "extra", {get: () => {throw new Error("must not execute");}, enumerable: true});
    expect(() => parseSimulationStateV2(accessor)).toThrow(/data property/);
    const extendedArray = ["tca:mandate"];
    Object.defineProperty(extendedArray, "extra", {value: true, enumerable: true});
    expect(() => parseSimulationStateV2({...input, territorialControlAuthorityOrder: extendedArray})).toThrow(/array element/);
  });

  it("rejects noncanonical, empty, duplicate, unsorted and unknown operation/scope/color values", () => {
    const {territorial, presentation} = fixture();
    for (const allowedTerritoryIds of [[], ["bad id"], ["한글"], ["a".repeat(513)], ["a", "a"], ["z", "a"]]) {
      expect(() => territorialControlAuthoritySchema.parse({...territorial, allowedTerritoryIds})).toThrow();
    }
    for (const allowedOperations of [[], ["attack"], ["occupy", "occupy"], ["transfer", "occupy"]]) {
      expect(() => territorialControlAuthoritySchema.parse({...territorial, allowedOperations})).toThrow();
    }
    for (const allowedMapColors of [[], ["#cc0000"], ["red"], ["#FFF"], ["#FFFFFF", "#CC0000"], ["#CC0000", "#CC0000"]]) {
      expect(() => countryPresentationAuthoritySchema.parse({...presentation, allowedMapColors})).toThrow();
    }
  });

  it("accepts exact caps and rejects cap+1 for collections and authority scopes", () => {
    const {input, territorial, presentation} = fixture();
    const ids = (count: number, prefix: string) => Array.from({length: count},
      (_, index) => `${prefix}${String(index).padStart(3, "0")}`);
    const record = (count: number, authority: typeof territorial | typeof presentation, prefix: string) =>
      Object.fromEntries(ids(count, prefix).map((id) => [id, {...authority, id}]));
    for (const count of [256, 257]) {
      const authorities = record(count, territorial, "tca:");
      const candidate = {...input, territorialControlAuthoritiesById: authorities,
        territorialControlAuthorityOrder: Object.keys(authorities)};
      if (count === 256) expect(() => parseSimulationStateV2(candidate)).not.toThrow();
      else expect(() => parseSimulationStateV2(candidate)).toThrow();
    }
    for (const count of [128, 129]) {
      const authorities = record(count, presentation, "cpa:");
      const candidate = {...input, countryPresentationAuthoritiesById: authorities,
        countryPresentationAuthorityOrder: Object.keys(authorities)};
      if (count === 128) expect(() => parseSimulationStateV2(candidate)).not.toThrow();
      else expect(() => parseSimulationStateV2(candidate)).toThrow();
    }
    expect(() => territorialControlAuthoritySchema.parse({...territorial, allowedTerritoryIds: ids(512, "micro:")})).not.toThrow();
    expect(() => territorialControlAuthoritySchema.parse({...territorial, allowedTerritoryIds: ids(513, "micro:")})).toThrow();
    const colors = Array.from({length: 17}, (_, index) => `#${index.toString(16).toUpperCase().padStart(6, "0")}`);
    expect(() => countryPresentationAuthoritySchema.parse({...presentation, allowedMapColors: colors.slice(0, 16)})).not.toThrow();
    expect(() => countryPresentationAuthoritySchema.parse({...presentation, allowedMapColors: colors})).toThrow();
    // Record cap also holds without a corresponding (bounded) order.
    expect(() => parseSimulationStateV2({...input,
      territorialControlAuthoritiesById: record(257, territorial, "tca:")})).toThrow(/cap/);
  });

  it("rejects inactive actor/target, missing source event, and missing territory references", () => {
    const {input, territorial, presentation, world} = fixture();
    for (const actorCountryId of ["ZZZ", "OLD"]) {
      expect(() => createSimulationStateV2({...input, territorialControlAuthoritiesById: {
        [territorial.id]: {...territorial, actorCountryId}}},
      {...world, retiredCountryIds: ["OLD"]})).toThrow(/inactive/);
    }
    for (const patch of [{targetCountryId: "ZZZ"}, {sourceEventId: "event.missing"},
      {allowedTerritoryIds: ["micro:missing"]}]) {
      expect(() => createSimulationStateV2({...input,
        territorialControlAuthoritiesById: {[territorial.id]: {...territorial, ...patch}}}, world)).toThrow();
    }
    for (const patch of [{actorCountryId: "ZZZ"}, {targetCountryId: "OLD"}, {sourceEventId: "event.missing"}]) {
      expect(() => createSimulationStateV2({...input,
        countryPresentationAuthoritiesById: {[presentation.id]: {...presentation, ...patch}}}, world)).toThrow();
    }
    expect(() => createSimulationStateV2({...input,
      territorialControlAuthoritiesById: {[territorial.id]: {...territorial, targetCountryId: null}}}, world)).not.toThrow();
    // No geometry dependency in the port used by the future World V3 migration.
    expect(() => createSimulationStateV2(input, {countriesById: world.countriesById,
      retiredCountryIds: [], territoriesById: Object.fromEntries(world.territoryOrder.map((id) => [id, {id}]))})).not.toThrow();
    const catalogId = `territory:catalog:${"a".repeat(64)}`;
    expect(() => createSimulationStateV2({...input, territorialControlAuthoritiesById: {
      [territorial.id]: {...territorial, allowedTerritoryIds: [catalogId]}},
    }, {...world, territoriesById: {[catalogId]: {id: catalogId}}})).not.toThrow();
  });

  it("retains strict legacy ordering and reference checks", () => {
    const {input, world} = fixture();
    expect(() => createSimulationStateV2({...input, factOrder: []}, world)).toThrow();
    expect(() => createSimulationStateV2({...input, situationOrder: []}, world)).toThrow();
    expect(() => createSimulationStateV2({...input, factsById: {
      "fact.1": {...input.factsById["fact.1"], factId: "fact.wrong"}}}, world)).toThrow(/key/);
    expect(() => createSimulationStateV2({...input, eventLog: []}, world)).toThrow(/event/);
    expect(() => createSimulationStateV2({...input, queuedActions: Array(129).fill(input.queuedActions[0])}, world)).toThrow();
  });
});

describe("14-4 canonical serialization and content hash", () => {
  it("round trips populated and empty migrations deterministically", () => {
    const {state, empty, world, input, territorial} = fixture();
    for (const candidate of [state, empty]) {
      const raw = serializeSimulationStateV2(candidate, world);
      expect(deserializeSimulationStateV2(raw, world)).toEqual(candidate);
      expect(serializeSimulationStateV2(deserializeSimulationStateV2(raw, world), world)).toBe(raw);
      expect(simulationStateV2ContentHash(candidate)).toMatch(/^[0-9a-f]{64}$/);
    }
    const records = {"tca:mandate": territorial, "tca:z": {...territorial, id: "tca:z"}};
    const forward = createSimulationStateV2({...input,
      territorialControlAuthoritiesById: records, territorialControlAuthorityOrder: Object.keys(records)}, world);
    const reverse = createSimulationStateV2({...forward,
      territorialControlAuthoritiesById: Object.fromEntries(Object.entries(records).reverse())}, world);
    expect(serializeSimulationStateV2(forward, world)).toBe(serializeSimulationStateV2(reverse, world));
    expect(simulationStateV2ContentHash(forward)).toBe(simulationStateV2ContentHash(reverse));
  });

  it("hashes each authority collection and rejects tampered or invalid serialized content", () => {
    const {state, world, input, territorial, presentation} = fixture();
    const hash = simulationStateV2ContentHash(state);
    for (const patch of [
      {territorialControlAuthoritiesById: {[territorial.id]: {...territorial, validTo: null}}},
      {countryPresentationAuthoritiesById: {[presentation.id]: {...presentation, allowedMapColors: ["#000000"]}}},
      {territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: []},
      {countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []},
    ]) {
      expect(simulationStateV2ContentHash(createSimulationStateV2({...input, ...patch}, world))).not.toBe(hash);
    }
    const saved = JSON.parse(serializeSimulationStateV2(state, world));
    saved.simulation.countryPresentationAuthoritiesById[presentation.id].allowedMapColors = ["#000000"];
    expect(() => deserializeSimulationStateV2(JSON.stringify(saved), world)).toThrow(/hash mismatch/);
    saved.contentHash = "A".repeat(64);
    expect(() => deserializeSimulationStateV2(JSON.stringify(saved), world)).toThrow();
    expect(() => deserializeSimulationStateV2("{bad", world)).toThrow();
  });
});

const atomicFixture = () => {
  const f = fixture();
  const legacyPlan = createResolvedTurnPlan({
    turnId: "turn.v2", simulation: f.legacy, world: f.world,
    subdivisionCatalog: {listCountry: () => [], inspect: () => null, materialize: () => null},
    resolution: {
      contractVersion: "turn-resolution.v1", baseSimulationRevision: 0, baseWorldRevision: 0,
      period: {startDate: "2020-01-01", endDate: "2020-02-01"},
      playerActionOutcomes: [{outcomeId: "outcome.1", actionId: "action.1", status: "succeeded",
        evidenceEventId: "event.rename", summary: "Mandate implemented", remainingConditions: []}],
      events: [{...sourceEvent, eventId: "event.rename", date: "2020-01-15",
        causes: [{kind: "queued-action", id: "action.1"}]}],
      factMutations: [], situationMutations: [], scheduledConsequences: [],
      worldEffects: [{effectId: "effect.rename", causedByEventId: "event.rename", type: "country.renamed",
        countryId: "AAA", displayName: "New name"}], advisorSummary: "Name updated", unresolvedQuestions: [],
    },
  });
  const nextEmpty = migrateSimulationStateV1ToV2(legacyPlan.nextSimulationState, legacyPlan.nextWorldState);
  const next = createSimulationStateV2({...nextEmpty,
    territorialControlAuthoritiesById: {...f.state.territorialControlAuthoritiesById,
      "tca:new": {...f.territorial, id: "tca:new", validFrom: "2020-01-15", sourceEventId: "event.rename"}},
    territorialControlAuthorityOrder: ["tca:mandate", "tca:new"],
    countryPresentationAuthoritiesById: {[f.presentation.id]: {...f.presentation, allowedMapColors: ["#000000"]}},
    countryPresentationAuthorityOrder: f.state.countryPresentationAuthorityOrder,
  }, legacyPlan.nextWorldState);
  const plan: ResolvedTurnPlan<SimulationStateV2> = Object.freeze({...legacyPlan,
    baseSimulationState: f.state, nextSimulationState: next,
    beforeSimulationHash: simulationStateV2ContentHash(f.state), afterSimulationHash: simulationStateV2ContentHash(next),
  });
  return {...f, plan, runtime: createAtomicTurnRuntime(f.state, f.world)};
};

describe("14-4 existing atomic runtime with Simulation V2", () => {
  it("commits and restores both worlds and all four authority collections through undo/redo", () => {
    const {runtime, plan, state, world} = atomicFixture();
    const seen: string[] = [];
    runtime.subscribe(({kind, next}) => {
      expect(next.revisions.simulationRevision).toBe(next.simulation.revision);
      expect(next.revisions.worldRevision).toBe(next.world.revision);
      seen.push(kind);
    });
    const after = runtime.commit(plan);
    expect(after.world.countriesById.AAA.names.mapKo).toBe("New name");
    expect(after.simulation).toBe(plan.nextSimulationState);
    expect(after.simulation.territorialControlAuthoritiesById["tca:new"].sourceEventId).toBe("event.rename");
    expect(runtime.getHistory().entries[0].beforeSimulation).toBe(state);
    const before = runtime.undo();
    expect(before.world.countriesById).toEqual(world.countriesById);
    expect({...before.simulation, revision: state.revision}).toEqual(state);
    expect(before.simulation.territorialControlAuthoritiesById["tca:new"]).toBeUndefined();
    expect(before.simulation.eventLog.some((event) => event.eventId === "event.rename")).toBe(false);
    const redone = runtime.redo();
    expect(redone.world.countriesById).toEqual(after.world.countriesById);
    expect({...redone.simulation, revision: after.simulation.revision}).toEqual(after.simulation);
    expect(seen).toEqual(["commit", "undo", "redo"]);
    expect(redone.simulation.revision).toBe(3);
    expect(redone.world.revision).toBe(after.world.revision + 2);
  });

  it("preserves authorities when replacing queued actions", () => {
    const {runtime, state} = atomicFixture();
    const snapshot = runtime.replacePendingActions([]);
    expect(snapshot.simulation.queuedActions).toEqual([]);
    expect(snapshot.simulation.territorialControlAuthoritiesById).toEqual(state.territorialControlAuthoritiesById);
    expect(snapshot.simulation.countryPresentationAuthoritiesById).toEqual(state.countryPresentationAuthoritiesById);
  });

  it("rejects stale pairs, bad hashes and invalid final references without partial mutation", () => {
    const {runtime, plan} = atomicFixture();
    const before = runtime.getSnapshot();
    const invalidWorld = createWorldStateV2({...plan.nextWorldState,
      countriesById: Object.fromEntries(Object.entries(plan.nextWorldState.countriesById).filter(([id]) => id !== "BBB")),
      countryOrder: plan.nextWorldState.countryOrder.filter((id) => id !== "BBB"),
      territoriesById: Object.fromEntries(Object.entries(plan.nextWorldState.territoriesById).map(([id, territory]) =>
        [id, territory.ownerCountryId === "BBB" ? {...territory, ownerCountryId: null} : territory])),
      retiredCountryIds: ["BBB" as RetiredCountryId],
    });
    for (const patch of [
      {baseSimulationState: parseSimulationStateV2(plan.baseSimulationState)},
      {beforeSimulationHash: "0".repeat(64)}, {afterSimulationHash: "0".repeat(64)},
      {beforeWorldHash: "0".repeat(64)}, {afterWorldHash: "0".repeat(64)},
      {nextSimulationState: createSimulationStateV2({...plan.nextSimulationState, revision: 0}, plan.nextWorldState)},
      {nextSimulationState: JSON.parse(JSON.stringify(plan.nextSimulationState)) as SimulationStateV2},
      {nextWorldState: invalidWorld},
    ]) {
      expect(() => runtime.commit({...plan, ...patch})).toThrow();
      expect(runtime.getSnapshot()).toBe(before);
      expect(runtime.getHistory().pointer).toBe(0);
    }
  });

  it("rolls back pair and history on publication failures for commit, undo, and redo", () => {
    const {runtime, plan} = atomicFixture();
    const fail = () => {throw new Error("publisher failed");};
    const initial = runtime.getSnapshot();
    expect(() => runtime.commit(plan, fail)).toThrow(/publisher failed/);
    expect(runtime.getSnapshot()).toBe(initial);
    expect(runtime.getHistory()).toEqual({entries: [], pointer: 0});
    const committed = runtime.commit(plan);
    expect(() => runtime.undo(fail)).toThrow();
    expect(runtime.getSnapshot()).toBe(committed);
    expect(runtime.getHistory().pointer).toBe(1);
    const undone = runtime.undo();
    expect(() => runtime.redo(fail)).toThrow();
    expect(runtime.getSnapshot()).toBe(undone);
    expect(runtime.getHistory().pointer).toBe(0);
    runtime.redo();
    expect(runtime.getHistory().pointer).toBe(1);
  });

  it("rejects duplicate commits and trims redo history after a new commit", () => {
    const {runtime, plan} = atomicFixture();
    runtime.commit(plan);
    expect(() => runtime.commit({...plan, baseSimulationState: runtime.getSnapshot().simulation,
      baseWorldState: runtime.getSnapshot().world})).toThrow(/already/);
    const before = runtime.undo();
    const next = createSimulationStateV2({...plan.nextSimulationState, revision: before.simulation.revision + 1},
      plan.nextWorldState);
    const nextWorld = createWorldStateV2({...plan.nextWorldState, revision: before.world.revision + 1});
    runtime.commit({...plan, turnId: "turn.branch", baseSimulationState: before.simulation,
      baseWorldState: before.world, nextSimulationState: next, nextWorldState: nextWorld,
      beforeSimulationHash: simulationStateV2ContentHash(before.simulation),
      afterSimulationHash: simulationStateV2ContentHash(next),
      beforeWorldHash: checkpointWorldContentHash(before.world), afterWorldHash: checkpointWorldContentHash(nextWorld)});
    expect(runtime.getHistory().entries.map((entry) => entry.turnId)).toEqual(["turn.branch"]);
    const current = runtime.getSnapshot();
    expect(runtime.redo()).toBe(current);
    expect(canonicalStringify(current.simulation.countryPresentationAuthorityOrder)).toBe('["cpa:mandate"]');
  });
});
