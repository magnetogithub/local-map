import {describe, expect, it} from "vitest";

import {parseCountryDissolveV2Command} from "../commands/country-dissolve-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity, type CountryEntity} from "../world/country-entity";
import {issueCountryId, createCountryIdRegistry} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryEntity} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {
  DISSOLVE_MERGE_METADATA_SUCCESSION,
  planCountryDissolve,
} from "./country-dissolve-planner";

const territoryIds = {
  north: deriveTerritoryId({kind: "seed", seedVersion: "planner-v1", sourceFeatureId: "north"}),
  south: deriveTerritoryId({kind: "seed", seedVersion: "planner-v1", sourceFeatureId: "south"}),
  target: deriveTerritoryId({kind: "seed", seedVersion: "planner-v1", sourceFeatureId: "target"}),
};

const geometryHashPolicy = {
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise" as const,
};

const country = (
  id: "AAA" | "BBB",
  input: Partial<Omit<CountryEntity, "id">> = {},
) => createCountryEntity({
  id: issueCountryId(id, createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []})),
  names: {
    shortKo: `${id} 단축명`,
    officialKo: `${id} 공식명`,
    mapKo: `${id} 지도명`,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
  ...input,
});

const territory = (
  id: (typeof territoryIds)[keyof typeof territoryIds],
  ownerCountryId: CountryEntity["id"],
  offset: number,
) => createTerritoryEntity({
  id,
  ownerCountryId,
  geometry: {
    type: "Polygon",
    coordinates: [[[offset, 0], [offset + 1, 0], [offset + 1, 1], [offset, 1], [offset, 0]]],
  },
  properties: {region: id},
});

const roots = (
  countriesById: Readonly<Record<string, CountryEntity>>,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
) => ({
  countriesRootHash: buildDomainRootHash("countries", Object.fromEntries(
    Object.entries(countriesById).map(([id, value]) => [id, countryCoreLeafHash(value)]),
  )),
  presentationRootHash: buildDomainRootHash("presentation", Object.fromEntries(
    Object.entries(countriesById).map(([id, value]) => [
      id,
      countryPresentationLeafHash(value, "world-policy-v1"),
    ]),
  )),
  territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
    Object.entries(territoriesById).flatMap(([id, value]) => [
      [`geometry:${id}`, territoryGeometryLeafHash(value, geometryHashPolicy)],
      [`ownership:${id}`, territoryOwnershipLeafHash(value)],
    ]),
  )),
  topologyRootHash: buildDomainRootHash("topology", {}),
});

const fixture = () => {
  const source = country("AAA", {
    names: {
      shortKo: "해산국",
      officialKo: "해산국 공화국",
      mapKo: "해산국",
      english: "Dissolved Republic",
      searchAliases: ["AAA", "Old Ally"],
    },
    politicalStatus: "unrecognized",
    moduleVersions: {core: 3, economy: 4, names: 1},
  });
  const target = country("BBB", {
    names: {
      shortKo: "승계국",
      officialKo: "승계국 공화국",
      mapKo: "승계국",
      english: "Successor Republic",
      searchAliases: ["BBB", "Ally"],
    },
    moduleVersions: {core: 2, diplomacy: 5, economy: 2, names: 2},
  });
  const countriesById = {AAA: source, BBB: target};
  const territoriesById = {
    [territoryIds.north]: territory(territoryIds.north, source.id, 0),
    [territoryIds.south]: territory(territoryIds.south, source.id, 2),
    [territoryIds.target]: territory(territoryIds.target, target.id, 4),
  };
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "planner-v1",
    policyVersion: "world-policy-v1",
    revision: 12,
    countriesById,
    countryOrder: [source.id, target.id],
    retiredCountryIds: ["OLD" as never],
    territoriesById,
    territoryOrder: Object.keys(territoriesById) as Array<TerritoryEntity["id"]>,
    topology: createTopologyState([]),
    hashRoots: roots(countriesById, territoriesById),
  });
};

const command = (targetCountryId = "BBB", dispositions = [territoryIds.north, territoryIds.south]) =>
  parseCountryDissolveV2Command({
    commandId: "merge-aaa-into-bbb",
    type: "country.dissolve",
    expectedRevision: 12,
    payload: {
      sourceCountryId: "AAA",
      territoryDispositions: dispositions.map((territoryId) => ({
        territoryId,
        disposition: {type: "merge", targetCountryId},
      })),
    },
  });

describe("10-66 dissolve-merge planner", () => {
  it("moves every source Territory, retires the source, and applies every metadata rule", () => {
    const state = fixture();
    const before = JSON.stringify(state);
    const result = planCountryDissolve(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    expect(next.revision).toBe(13);
    expect(next.countryOrder).toEqual(["BBB"]);
    expect(next.countriesById.AAA).toBeUndefined();
    expect(next.retiredCountryIds.has("AAA" as never)).toBe(true);
    expect(Object.values(next.territoriesById).filter(({ownerCountryId}) => ownerCountryId === "AAA"))
      .toHaveLength(0);
    expect(next.territoriesById[territoryIds.north].ownerCountryId).toBe("BBB");
    expect(next.territoriesById[territoryIds.south].ownerCountryId).toBe("BBB");

    const successor = next.countriesById.BBB;
    expect(successor.names.shortKo).toBe("승계국");
    expect(successor.names.searchAliases).toEqual([
      "AAA",
      "Ally",
      "BBB",
      "Dissolved Republic",
      "Old Ally",
      "해산국",
      "해산국 공화국",
    ]);
    expect(successor.politicalStatus).toBe("sovereign");
    expect(successor.presentationOverride).toBeNull();
    expect(successor.moduleVersions).toEqual({core: 3, diplomacy: 5, economy: 4, names: 2});
    expect(result.plan.patch.metadataSuccessionByTarget.BBB.fields)
      .toEqual(DISSOLVE_MERGE_METADATA_SUCCESSION);
    expect(Object.keys(result.plan.patch.metadataSuccessionByTarget.BBB.fields).sort()).toEqual([
      "moduleVersions",
      "names",
      "politicalStatus",
      "presentationOverride",
    ]);
    expect(next.topology).toBe(state.topology);
    expect(next.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(next.hashRoots.countriesRootHash).not.toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(Object.isFrozen(result.plan.patch.metadataSuccessionByTarget)).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ["unknown target", command("ZZZ"), "country-not-found"],
    ["retired target", command("OLD"), "country-id-retired"],
    ["self target", command("AAA"), "country-target-self"],
    ["missing disposition", command("BBB", [territoryIds.north]), "territory-disposition-missing"],
    ["foreign territory", command("BBB", [territoryIds.north, territoryIds.target]), "territory-not-owned-by-source"],
  ])("rejects %s without exposing a partial state", (_label, invalidCommand, code) => {
    const state = fixture();
    const result = planCountryDissolve(state, invalidCommand, {committedCommandIds: new Set()});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
    expect(state.revision).toBe(12);
    expect(state.countriesById.AAA).toBeDefined();
    expect(state.territoriesById[territoryIds.north].ownerCountryId).toBe("AAA");
  });

  it("runs revision and idempotency gates before dissolve semantics", () => {
    const state = fixture();
    const stale = parseCountryDissolveV2Command({...command(), expectedRevision: 11});
    const duplicate = command();

    expect(planCountryDissolve(state, stale, {committedCommandIds: new Set()})).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({code: "stale-revision"}),
      }),
    );
    expect(planCountryDissolve(
      state,
      duplicate,
      {committedCommandIds: new Set([duplicate.commandId])},
    )).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "duplicate-command-id"}),
    }));
  });
});

const dispositionCommand = (
  type: "unclaim" | "transfer",
  ids = [territoryIds.north, territoryIds.south],
  targetCountryId = "BBB",
) => parseCountryDissolveV2Command({
  commandId: `dissolve-${type}`,
  type: "country.dissolve",
  expectedRevision: 12,
  payload: {
    sourceCountryId: "AAA",
    territoryDispositions: ids.map((territoryId) => ({
      territoryId,
      disposition: type === "unclaim" ? {type} : {type, targetCountryId},
    })),
  },
});

describe("10-64 dissolve-unclaim planner", () => {
  it("unclaims every source Territory and retires the source in one immutable revision", () => {
    const state = fixture(); const before = JSON.stringify(state);
    const result = planCountryDissolve(state, dispositionCommand("unclaim"), {committedCommandIds: new Set()});
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.nextState.revision).toBe(13);
    expect(result.plan.nextState.countriesById.AAA).toBeUndefined();
    expect(result.plan.nextState.retiredCountryIds.has("AAA" as never)).toBe(true);
    expect(result.plan.nextState.territoriesById[territoryIds.north].ownerCountryId).toBeNull();
    expect(result.plan.nextState.territoriesById[territoryIds.south].ownerCountryId).toBeNull();
    expect(result.plan.nextState.topology).toBe(state.topology);
    expect(JSON.stringify(state)).toBe(before);
  });
  it.each([
    ["missing", dispositionCommand("unclaim", [territoryIds.north]), "territory-disposition-missing"],
    ["duplicate", dispositionCommand("unclaim", [territoryIds.north, territoryIds.north, territoryIds.south]), "territory-disposition-duplicate"],
    ["foreign", dispositionCommand("unclaim", [territoryIds.north, territoryIds.target]), "territory-not-owned-by-source"],
  ])("rejects %s dispositions", (_label, invalid, code) => {
    expect(planCountryDissolve(fixture(), invalid, {committedCommandIds: new Set()})).toEqual(expect.objectContaining({ok:false,error:expect.objectContaining({code})}));
  });
});

describe("10-65 dissolve-transfer planner", () => {
  it("transfers all source Territories without merge metadata succession", () => {
    const state = fixture(); const targetBefore = state.countriesById.BBB;
    const result = planCountryDissolve(state, dispositionCommand("transfer"), {committedCommandIds: new Set()});
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.plan.nextState.revision).toBe(13);
    expect(result.plan.nextState.countriesById.AAA).toBeUndefined();
    expect(result.plan.nextState.countriesById.BBB).toBe(targetBefore);
    expect(result.plan.patch.metadataSuccessionByTarget).toEqual({});
    expect(result.plan.nextState.territoriesById[territoryIds.north].ownerCountryId).toBe("BBB");
    expect(result.plan.nextState.territoriesById[territoryIds.south].ownerCountryId).toBe("BBB");
  });
  it.each([
    ["unknown", dispositionCommand("transfer", undefined, "ZZZ"), "country-not-found"],
    ["retired", dispositionCommand("transfer", undefined, "OLD"), "country-id-retired"],
    ["self", dispositionCommand("transfer", undefined, "AAA"), "country-target-self"],
    ["missing", dispositionCommand("transfer", [territoryIds.north]), "territory-disposition-missing"],
    ["duplicate", dispositionCommand("transfer", [territoryIds.north, territoryIds.north, territoryIds.south]), "territory-disposition-duplicate"],
    ["foreign", dispositionCommand("transfer", [territoryIds.north, territoryIds.target]), "territory-not-owned-by-source"],
  ])("rejects %s", (_label, invalid, code) => {
    expect(planCountryDissolve(fixture(), invalid, {committedCommandIds: new Set()})).toEqual(expect.objectContaining({ok:false,error:expect.objectContaining({code})}));
  });
});
