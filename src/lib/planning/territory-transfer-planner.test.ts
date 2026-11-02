import {describe, expect, it} from "vitest";

import {parseTerritoryTransferV2Command} from "../commands/territory-transfer-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId, type ActiveCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";
import {planTerritoryTransfer} from "./territory-transfer-planner";

const registry = createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []});
const sourceCountryId = issueCountryId("AAA", registry);
const targetCountryId = issueCountryId("BBB", registry);
const createCountry = (id: ActiveCountryId) => createCountryEntity({
  id,
  names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});
const sourceCountry = createCountry(sourceCountryId);
const targetCountry = createCountry(targetCountryId);
const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "transfer-v1", sourceFeatureId});
const transferredId = territory("transferred");
const unclaimedId = territory("unclaimed");
const unknownId = territory("unknown");
const geometryHashPolicy = {coordinatePrecision: 9, exteriorRingWinding: "counterclockwise" as const};

const rectangle = (left: number, right: number, top = 5): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[[left, 0], [right, 0], [right, top], [left, top], [left, 0]]],
});

const fixture = () => {
  const transferred = createTerritoryEntity({
    id: transferredId,
    ownerCountryId: sourceCountryId,
    geometry: rectangle(0, 4),
    properties: {region: "transfer"},
  });
  const unclaimed = createTerritoryEntity({
    id: unclaimedId,
    ownerCountryId: null,
    geometry: rectangle(10, 11),
    properties: {region: "free"},
  });
  const countriesById = {AAA: sourceCountry, BBB: targetCountry};
  const territoriesById = {[transferred.id]: transferred, [unclaimed.id]: unclaimed};
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "transfer-v1",
    policyVersion: "world-policy-v1",
    revision: 17,
    countriesById,
    countryOrder: [sourceCountryId, targetCountryId],
    retiredCountryIds: ["OLD" as never],
    territoriesById,
    territoryOrder: [transferred.id, unclaimed.id],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {
        AAA: countryCoreLeafHash(sourceCountry),
        BBB: countryCoreLeafHash(targetCountry),
      }),
      presentationRootHash: buildDomainRootHash("presentation", {
        AAA: countryPresentationLeafHash(sourceCountry, "world-policy-v1"),
        BBB: countryPresentationLeafHash(targetCountry, "world-policy-v1"),
      }),
      territoriesRootHash: buildDomainRootHash("territories", Object.fromEntries(
        Object.entries(territoriesById).flatMap(([id, value]) => [
          [`geometry:${id}`, territoryGeometryLeafHash(value, geometryHashPolicy)],
          [`ownership:${id}`, territoryOwnershipLeafHash(value)],
        ]),
      )),
      topologyRootHash: buildDomainRootHash("topology", {}),
    },
  });
};

const command = (
  territoryId = transferredId,
  target = "BBB",
  overrides: Partial<{commandId: string; expectedRevision: number}> = {},
) => parseTerritoryTransferV2Command({
  commandId: overrides.commandId ?? "transfer-territory",
  type: "territory.transfer",
  expectedRevision: overrides.expectedRevision ?? 17,
  payload: {
    source: {kind: "territory-id", territoryId},
    targetCountryId: target,
  },
});

describe("10-71 territory.transfer planner", () => {
  it("moves ownership while preserving total area, geometry hash, and topology", () => {
    const state = fixture();
    const territoryBefore = state.territoriesById[transferredId];
    const geometryHashBefore = territoryGeometryLeafHash(territoryBefore, geometryHashPolicy);
    const ownershipHashBefore = territoryOwnershipLeafHash(territoryBefore);
    const before = JSON.stringify(state);
    const result = planTerritoryTransfer(state, command(), {committedCommandIds: new Set()});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.plan.nextState;
    const territoryAfter = next.territoriesById[transferredId];
    const geometryHashAfter = territoryGeometryLeafHash(territoryAfter, geometryHashPolicy);
    expect(next.revision).toBe(18);
    expect(territoryAfter.ownerCountryId).toBe("BBB");
    expect(territoryAfter.geometry).toBe(territoryBefore.geometry);
    expect(territoryAfter.properties).toBe(territoryBefore.properties);
    expect(geometryHashAfter).toBe(geometryHashBefore);
    expect(territoryOwnershipLeafHash(territoryAfter)).not.toBe(ownershipHashBefore);
    expect(result.plan.patch).toEqual({
      kind: "territory.transfer",
      territoryId: transferredId,
      beforeOwnerCountryId: sourceCountryId,
      afterOwnerCountryId: targetCountryId,
      measurements: {
        areaBefore: 20,
        areaAfter: 20,
        areaDifference: 0,
        geometryHashBefore,
        geometryHashAfter,
      },
    });
    expect(next.territoriesById[unclaimedId]).toBe(state.territoriesById[unclaimedId]);
    expect(next.countriesById).toBe(state.countriesById);
    expect(next.countryOrder).toBe(state.countryOrder);
    expect(next.territoryOrder).toBe(state.territoryOrder);
    expect(next.topology).toBe(state.topology);
    expect(next.hashRoots.countriesRootHash).toBe(state.hashRoots.countriesRootHash);
    expect(next.hashRoots.presentationRootHash).toBe(state.hashRoots.presentationRootHash);
    expect(next.hashRoots.topologyRootHash).toBe(state.hashRoots.topologyRootHash);
    expect(next.hashRoots.territoriesRootHash).not.toBe(state.hashRoots.territoriesRootHash);
    expect(() => createWorldStateV2(next)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([
    ["unknown Territory", command(unknownId), "territory-not-found"],
    ["unclaimed Territory", command(unclaimedId), "territory-unclaimed"],
    ["self target", command(transferredId, "AAA"), "country-target-self"],
    ["unknown target", command(transferredId, "ZZZ"), "country-not-found"],
    ["retired target", command(transferredId, "OLD"), "country-id-retired"],
  ])("rejects %s without mutating state", (_label, invalidCommand, code) => {
    const state = fixture();
    const before = JSON.stringify(state);
    const result = planTerritoryTransfer(state, invalidCommand, {committedCommandIds: new Set()});

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code}),
    }));
    expect(JSON.stringify(state)).toBe(before);
  });

  it("leaves partition-result references for the batch-local resolver", () => {
    const deferred = parseTerritoryTransferV2Command({
      commandId: "transfer-partition-result",
      type: "territory.transfer",
      expectedRevision: 17,
      payload: {
        source: {kind: "partition-result", commandId: "partition-source", partitionKey: "west"},
        targetCountryId: "BBB",
      },
    });

    expect(planTerritoryTransfer(
      fixture(),
      deferred,
      {committedCommandIds: new Set()},
    )).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({code: "partition-result-unresolved"}),
    }));
  });
});
