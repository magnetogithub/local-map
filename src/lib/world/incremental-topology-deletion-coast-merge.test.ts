import {describe, expect, it} from "vitest";

import {buildCanonicalTopology} from "./canonical-topology";
import {
  initializeIncrementalTopology,
  recalculateTopologyIncrementally,
} from "./incremental-topology";
import {canonicalizeTopologySegment, topologySegmentKey} from "./shared-segment";
import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {createTerritoryEntity, type TerritoryEntity, type TerritoryGeometry} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import type {TopologyEdge, TopologyState} from "./topology-state";

const territory = (name: string, geometry: TerritoryGeometry) => createTerritoryEntity({
  id: deriveTerritoryId({kind: "seed", seedVersion: "deletion-coast-v1", sourceFeatureId: name}),
  ownerCountryId: null,
  geometry,
  properties: {},
});

const rectangle = (name: string, minX: number, minY: number, maxX: number, maxY: number) =>
  territory(name, {type: "Polygon", coordinates: [[
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
  ]]});

const coastEdges = (topology: TopologyState, territoryId: string) =>
  Object.values(topology.edgesById).filter(({classification, territoryIds}) =>
    classification === "coast" && territoryIds[0] === territoryId
  );

const leafHashes = (edges: readonly TopologyEdge[]) =>
  edges.map(topologyEdgeLeafHash).sort();

const expectExactFullBuild = (
  incremental: TopologyState,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
) => {
  const full = buildCanonicalTopology(territoriesById);
  expect(incremental.edgesById).toEqual(full.edgesById);
  expect(Object.keys(incremental.edgesById).sort()).toEqual(Object.keys(full.edgesById).sort());
  expect(leafHashes(Object.values(incremental.edgesById))).toEqual(leafHashes(Object.values(full.edgesById)));
  expect(incremental.neighborTerritoryIdsById).toEqual(full.neighborTerritoryIdsById);

  const coast = new Set<string>();
  const internal = new Set<string>();
  for (const edge of Object.values(incremental.edgesById)) {
    const target = edge.classification === "coast" ? coast : internal;
    for (let index = 1; index < edge.coordinates.length; index += 1) {
      const key = topologySegmentKey(canonicalizeTopologySegment(
        edge.coordinates[index - 1], edge.coordinates[index],
      ));
      expect(target.has(key)).toBe(false);
      target.add(key);
    }
  }
  expect([...coast].filter((key) => internal.has(key))).toEqual([]);
  return full;
};

describe("10-54 deletion coast canonical merge", () => {
  it("merges the exposed border into one B coast after deleting A", () => {
    const a = rectangle("delete-a", 0, 0, 1, 1);
    const b = rectangle("delete-b", 1, 0, 2, 1);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b});
    const topologySnapshot = JSON.stringify(before.topology);
    const bboxSnapshot = JSON.stringify(before.bboxIndex);
    const bSnapshot = JSON.stringify(b);
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[b.id]: b}, [a.id],
    );
    const full = expectExactFullBuild(result.topology, {[b.id]: b});

    expect(coastEdges(result.topology, b.id)).toHaveLength(1);
    expect(coastEdges(result.topology, b.id)[0]).toEqual(coastEdges(full, b.id)[0]);
    expect(topologyEdgeLeafHash(coastEdges(result.topology, b.id)[0]))
      .toBe(topologyEdgeLeafHash(coastEdges(full, b.id)[0]));
    expect(JSON.stringify(before.topology)).toBe(topologySnapshot);
    expect(JSON.stringify(before.bboxIndex)).toBe(bboxSnapshot);
    expect(JSON.stringify(b)).toBe(bSnapshot);
  });

  it("merges B coast after A completely moves out of contact", () => {
    const oldA = rectangle("move-a", 0, 0, 1, 1);
    const b = rectangle("move-b", 1, 0, 2, 1);
    const before = initializeIncrementalTopology({[oldA.id]: oldA, [b.id]: b});
    const movedA = rectangle("move-a", 10, 0, 11, 1);
    const territories = {[movedA.id]: movedA, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [movedA.id],
    );

    expectExactFullBuild(result.topology, territories);
    expect(coastEdges(result.topology, b.id)).toHaveLength(1);
  });

  it("merges a partially exposed border while retaining the shared remainder", () => {
    const oldA = rectangle("partial-a", 0, 0, 1, 2);
    const b = rectangle("partial-b", 1, 0, 2, 2);
    const before = initializeIncrementalTopology({[oldA.id]: oldA, [b.id]: b});
    const newA = rectangle("partial-a", 0, 0, 1, 1);
    const territories = {[newA.id]: newA, [b.id]: b};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [newA.id],
    );

    expectExactFullBuild(result.topology, territories);
    expect(Object.values(result.topology.edgesById).filter(({classification}) =>
      classification === "internal"
    )).toHaveLength(1);
  });

  it("keeps disconnected B coast components as separate canonical edges", () => {
    const a = rectangle("islands-a", 0, 0, 1, 1);
    const b = territory("islands-b", {type: "MultiPolygon", coordinates: [
      [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]],
      [[[5, 0], [6, 0], [6, 1], [5, 1], [5, 0]]],
    ]});
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b});
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[b.id]: b}, [a.id],
    );

    expectExactFullBuild(result.topology, {[b.id]: b});
    expect(coastEdges(result.topology, b.id)).toHaveLength(2);
  });

  it("merges independently exposed B and C coasts after deleting A", () => {
    const b = rectangle("multi-b", 0, 0, 1, 1);
    const a = rectangle("multi-a", 1, 0, 2, 1);
    const c = rectangle("multi-c", 2, 0, 3, 1);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [c.id]: c});
    const territories = {[b.id]: b, [c.id]: c};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, territories, [a.id],
    );

    expectExactFullBuild(result.topology, territories);
    expect(coastEdges(result.topology, b.id)).toHaveLength(1);
    expect(coastEdges(result.topology, c.id)).toHaveLength(1);
  });

  it("canonically merges a dateline coast after deleting A", () => {
    const b = territory("date-b", {type: "Polygon", coordinates: [[
      [179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0],
    ]]});
    const a = territory("date-a", {type: "Polygon", coordinates: [[
      [179, -1], [-179, -1], [-179, 0], [179, 0], [179, -1],
    ]]});
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b});
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[b.id]: b}, [a.id],
    );

    expectExactFullBuild(result.topology, {[b.id]: b});
    expect(coastEdges(result.topology, b.id)).toHaveLength(1);
    expect(coastEdges(result.topology, b.id)[0].coordinates.every((position, index, coordinates) =>
      index === 0 || Math.abs(position[0] - coordinates[index - 1][0]) <= 180
    )).toBe(true);
  });

  it("does not read non-direct C geometry during deletion", () => {
    const a = rectangle("guard-a", 0, 0, 1, 1);
    const b = rectangle("guard-b", 1, 0, 2, 1);
    const c = rectangle("guard-c", 2, 0, 3, 1);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [c.id]: c});
    let bReads = 0;
    let cReads = 0;
    const measuredB = {...b, get geometry() { bReads += 1; return b.geometry; }};
    const measuredC = {...c, get geometry() { cReads += 1; return c.geometry; }};
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[b.id]: measuredB, [c.id]: measuredC}, [a.id],
    );

    expect(result.recomputedTerritoryIds).toEqual([a.id, b.id].sort());
    expect(bReads).toBeGreaterThan(0);
    expect(cReads).toBe(0);
  });

  it("preserves remote edge IDs, hashes, and object references", () => {
    const a = rectangle("remote-a", 0, 0, 1, 1);
    const b = rectangle("remote-b", 1, 0, 2, 1);
    const remote = rectangle("remote", 20, 0, 21, 1);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [remote.id]: remote});
    const remoteBefore = coastEdges(before.topology, remote.id);
    const result = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[b.id]: b, [remote.id]: remote}, [a.id],
    );
    const remoteAfter = coastEdges(result.topology, remote.id);

    expect(remoteAfter.map(({id}) => id)).toEqual(remoteBefore.map(({id}) => id));
    expect(leafHashes(remoteAfter)).toEqual(leafHashes(remoteBefore));
    expect(remoteAfter[0]).toBe(remoteBefore[0]);
  });
});
