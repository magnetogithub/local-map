import {describe, expect, it} from "vitest";

import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {createTerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {
  initializeIncrementalTopology,
  recalculateTopologyIncrementally,
} from "./incremental-topology";

const square = (name: string, minX: number) => createTerritoryEntity({
  id: deriveTerritoryId({kind: "seed", seedVersion: "incremental-v1", sourceFeatureId: name}),
  ownerCountryId: null,
  geometry: {type: "Polygon", coordinates: [[
    [minX, 0], [minX + 1, 0], [minX + 1, 1], [minX, 1], [minX, 0],
  ]]},
  properties: {},
});

describe("10-54 incremental topology recalculation", () => {
  it("recomputes changed bbox candidates and preserves unrelated edge objects and hashes", () => {
    const alpha = square("alpha", 0);
    const beta = square("beta", 1);
    const remote = square("remote", 20);
    const before = initializeIncrementalTopology({[alpha.id]: alpha, [beta.id]: beta, [remote.id]: remote});
    const movedAlpha = square("alpha", -1);
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {[alpha.id]: movedAlpha, [beta.id]: beta, [remote.id]: remote},
      [alpha.id],
    );
    const remoteBefore = Object.values(before.topology.edgesById).filter(({territoryIds}) => territoryIds[0] === remote.id);
    const remoteAfter = Object.values(result.topology.edgesById).filter(({territoryIds}) => territoryIds[0] === remote.id);

    expect(result.recomputedTerritoryIds).toEqual(expect.arrayContaining([alpha.id, beta.id]));
    expect(result.recomputedTerritoryIds).not.toContain(remote.id);
    expect(remoteAfter.map(topologyEdgeLeafHash)).toEqual(remoteBefore.map(topologyEdgeLeafHash));
  });
});
