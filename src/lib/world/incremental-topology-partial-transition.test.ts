import {describe, expect, it} from "vitest";

import {buildCanonicalTopology} from "./canonical-topology";
import {
  initializeIncrementalTopology,
  recalculateTopologyIncrementally,
} from "./incremental-topology";
import {canonicalizeTopologySegment, topologySegmentKey} from "./shared-segment";
import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {createTerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import type {TopologyState} from "./topology-state";

const territory = (
  name: string,
  ring: readonly (readonly [number, number])[],
) => createTerritoryEntity({
  id: deriveTerritoryId({kind: "seed", seedVersion: "partial-transition-v1", sourceFeatureId: name}),
  ownerCountryId: null,
  geometry: {type: "Polygon", coordinates: [ring]},
  properties: {},
});
const rectangle = (
  name: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
) => territory(name, [
  [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
]);

const classifiedSegmentKeys = (topology: TopologyState) => {
  const internal = new Set<string>();
  const coast = new Set<string>();
  for (const edge of Object.values(topology.edgesById)) {
    const target = edge.classification === "internal" ? internal : coast;
    for (let index = 1; index < edge.coordinates.length; index += 1) {
      target.add(topologySegmentKey(canonicalizeTopologySegment(
        edge.coordinates[index - 1], edge.coordinates[index],
      )));
    }
  }
  return {internal, coast};
};

const expectEquivalentToFullBuild = (
  incremental: TopologyState,
  territoriesById: Parameters<typeof buildCanonicalTopology>[0],
) => {
  const full = buildCanonicalTopology(territoriesById);
  expect(incremental).toEqual(full);
  const {internal, coast} = classifiedSegmentKeys(incremental);
  expect([...internal].filter((key) => coast.has(key))).toEqual([]);
};

describe("10-54 partial coast/internal transitions", () => {
  it("turns only the front part of a long B coast into A-B internal", () => {
    const b = rectangle("b-front", 1, 0, 2, 2);
    const before = initializeIncrementalTopology({[b.id]: b});
    const a = rectangle("a-front", 0, 0, 1, 1);
    const territories = {[a.id]: a, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [a.id],
    );

    expectEquivalentToFullBuild(result.topology, territories);
  });

  it("turns only the middle of a long B coast into A-B internal", () => {
    const b = rectangle("b-middle", 1, 0, 2, 3);
    const before = initializeIncrementalTopology({[b.id]: b});
    const a = rectangle("a-middle", 0, 1, 1, 2);
    const territories = {[a.id]: a, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [a.id],
    );

    expectEquivalentToFullBuild(result.topology, territories);
  });

  it("turns the uncovered part of an old internal border into B coast", () => {
    const oldA = rectangle("a-shrink", 0, 0, 1, 2);
    const b = rectangle("b-shrink", 1, 0, 2, 2);
    const before = initializeIncrementalTopology({[oldA.id]: oldA, [b.id]: b});
    const newA = rectangle("a-shrink", 0, 0, 1, 1);
    const territories = {[newA.id]: newA, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [newA.id],
    );

    expectEquivalentToFullBuild(result.topology, territories);
  });

  it("expands an existing shared interval without duplicate coast", () => {
    const oldA = rectangle("a-expand", 0, 0, 1, 1);
    const b = rectangle("b-expand", 1, 0, 2, 2);
    const before = initializeIncrementalTopology({[oldA.id]: oldA, [b.id]: b});
    const newA = rectangle("a-expand", 0, 0, 1, 2);
    const territories = {[newA.id]: newA, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [newA.id],
    );

    expectEquivalentToFullBuild(result.topology, territories);
  });

  it("handles different split points on both sides", () => {
    const b = territory("b-split", [[1, 0], [2, 0], [2, 2], [1, 2], [1, 1.5], [1, 0]]);
    const before = initializeIncrementalTopology({[b.id]: b});
    const a = territory("a-split", [[0, 0], [1, 0], [1, 0.5], [1, 2], [0, 2], [0, 0]]);
    const territories = {[a.id]: a, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [a.id],
    );

    expectEquivalentToFullBuild(result.topology, territories);
  });

  it("splits a partial dateline coast/internal transition", () => {
    const b = territory("b-dateline", [[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]]);
    const before = initializeIncrementalTopology({[b.id]: b});
    const a = territory("a-dateline", [[179, -1], [-180, -1], [-180, 0], [179, 0], [179, -1]]);
    const territories = {[a.id]: a, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [a.id],
    );

    expectEquivalentToFullBuild(result.topology, territories);
  });

  it("preserves non-direct geometry isolation and unaffected remote edge hashes", () => {
    const b = rectangle("b-guard", 1, 0, 2, 2);
    const c = rectangle("c-guard", 2, 0, 3, 2);
    const remote = rectangle("remote-guard", 20, 0, 21, 1);
    const before = initializeIncrementalTopology({[b.id]: b, [c.id]: c, [remote.id]: remote});
    const remoteHashes = Object.values(before.topology.edgesById)
      .filter(({territoryIds}) => territoryIds[0] === remote.id)
      .map(topologyEdgeLeafHash);
    let cGeometryReads = 0;
    const guardedC = {
      id: c.id,
      ownerCountryId: c.ownerCountryId,
      get geometry() {
        cGeometryReads += 1;
        return c.geometry;
      },
      properties: c.properties,
    };
    const a = rectangle("a-guard", 0, 0, 1, 1);
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {[a.id]: a, [b.id]: b, [c.id]: guardedC, [remote.id]: remote},
      [a.id],
    );
    const remoteAfter = Object.values(result.topology.edgesById)
      .filter(({territoryIds}) => territoryIds[0] === remote.id)
      .map(topologyEdgeLeafHash);

    expect(cGeometryReads).toBe(0);
    expect(remoteAfter).toEqual(remoteHashes);
  });

  it("does not mutate the input topology or Territory entities", () => {
    const b = rectangle("b-immutable", 1, 0, 2, 2);
    const before = initializeIncrementalTopology({[b.id]: b});
    const a = rectangle("a-immutable", 0, 0, 1, 1);
    const territories = {[a.id]: a, [b.id]: b};
    const topologySnapshot = JSON.stringify(before.topology);
    const territoriesSnapshot = JSON.stringify(territories);

    recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [a.id],
    );

    expect(JSON.stringify(before.topology)).toBe(topologySnapshot);
    expect(JSON.stringify(territories)).toBe(territoriesSnapshot);
  });
});
