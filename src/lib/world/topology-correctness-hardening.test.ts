import {describe, expect, it} from "vitest";

import {buildCanonicalTopology} from "./canonical-topology";
import {
  initializeIncrementalTopology,
  recalculateTopologyIncrementally,
} from "./incremental-topology";
import {extractSharedTopologySegments} from "./shared-segment";
import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {createTerritoryEntity, type TerritoryGeometry} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";

const polygon = (ring: readonly (readonly [number, number])[]): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [ring],
});
const entity = (name: string, ring: readonly (readonly [number, number])[]) =>
  createTerritoryEntity({
    id: deriveTerritoryId({kind: "seed", seedVersion: "topology-hardening-v1", sourceFeatureId: name}),
    ownerCountryId: null,
    geometry: polygon(ring),
    properties: {},
  });
const rectangle = (name: string, minX: number, maxX: number) => entity(name, [
  [minX, 0], [maxX, 0], [maxX, 1], [minX, 1], [minX, 0],
]);
const internalHash = (topology: ReturnType<typeof buildCanonicalTopology>, left: string, right: string) => {
  const edge = Object.values(topology.edgesById).find(({classification, territoryIds}) =>
    classification === "internal" && territoryIds.includes(left as never) && territoryIds.includes(right as never)
  );
  return edge ? topologyEdgeLeafHash(edge) : null;
};

describe("10-48/49/52 split-point-independent shared boundaries", () => {
  it("splits one long segment against two short segments into two atomic shared segments", () => {
    const left = polygon([[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]);
    const right = polygon([[1, 0], [2, 0], [2, 2], [1, 2], [1, 1], [1, 0]]);

    expect(extractSharedTopologySegments(left, right)).toEqual([
      [[1, 0], [1, 1]],
      [[1, 1], [1, 2]],
    ]);
  });

  it("uses all break points when both sides split the same boundary differently", () => {
    const left = polygon([[0, 0], [1, 0], [1, 0.5], [1, 2], [0, 2], [0, 0]]);
    const right = polygon([[1, 0], [2, 0], [2, 2], [1, 2], [1, 1.5], [1, 0]]);

    expect(extractSharedTopologySegments(left, right)).toHaveLength(3);
  });

  it("returns only a positive-length partial overlap", () => {
    const left = polygon([[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]);
    const right = polygon([[1, 1], [2, 1], [2, 3], [1, 3], [1, 1]]);

    expect(extractSharedTopologySegments(left, right)).toEqual([[[1, 1], [1, 2]]]);
  });

  it("rejects disjoint collinear, point-only, and bbox-only contact", () => {
    const base = polygon([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
    const disjoint = polygon([[1, 2], [2, 2], [2, 3], [1, 3], [1, 2]]);
    const point = polygon([[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]);
    const overlap = polygon([[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]);

    expect(extractSharedTopologySegments(base, disjoint)).toEqual([]);
    expect(extractSharedTopologySegments(base, point)).toEqual([]);
    expect(extractSharedTopologySegments(base, overlap)).toEqual([]);
  });

  it("is direction/input-order independent and merges the internal path", () => {
    const left = entity("left", [[0, 0], [1, 0], [1, 2], [0, 2], [0, 0]]);
    const right = entity("right", [[1, 0], [2, 0], [2, 2], [1, 2], [1, 1], [1, 0]]);
    const forward = buildCanonicalTopology({[left.id]: left, [right.id]: right});
    const reverse = buildCanonicalTopology({[right.id]: right, [left.id]: left});
    const internal = Object.values(forward.edgesById).filter(({classification}) => classification === "internal");

    expect(Object.keys(forward.edgesById)).toEqual(Object.keys(reverse.edgesById));
    expect(forward.neighborTerritoryIdsById[left.id]).toEqual([right.id]);
    expect(forward.neighborTerritoryIdsById[right.id]).toEqual([left.id]);
    expect(internal).toHaveLength(1);
    expect(internal[0].coordinates).toEqual([[1, 0], [1, 1], [1, 2]]);
    expect(Object.values(forward.edgesById).filter(({classification, coordinates}) =>
      classification === "coast" && coordinates.some(([x], index) =>
        index > 0 && x === 1 && coordinates[index - 1][0] === 1
      )
    )).toHaveLength(0);
  });

  it("handles a differently split dateline boundary without a long segment", () => {
    const north = entity("north", [[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]]);
    const south = entity("south", [[179, -1], [-179, -1], [-179, 0], [-180, 0], [179, 0], [179, -1]]);
    const topology = buildCanonicalTopology({[north.id]: north, [south.id]: south});
    const internal = Object.values(topology.edgesById).filter(({classification}) => classification === "internal");

    expect(topology.neighborTerritoryIdsById[north.id]).toEqual([south.id]);
    expect(internal).toHaveLength(1);
    expect(internal[0].coordinates.every((position, index) =>
      index === 0 || Math.abs(position[0] - internal[0].coordinates[index - 1][0]) <= 180
    )).toBe(true);
  });
});

describe("10-54 direct-candidate incremental topology", () => {
  it("does not expand A's recomputation through B to C", () => {
    const a = rectangle("a", 0, 1);
    const b = rectangle("b", 1, 2);
    const c = rectangle("c", 2, 3);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [c.id]: c});
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {[a.id]: rectangle("a", -0.25, 0.75), [b.id]: b, [c.id]: c},
      [a.id],
    );

    expect(result.recomputedTerritoryIds).toEqual([a.id, b.id].sort());
    expect(result.recomputedTerritoryIds).not.toContain(c.id);
  });

  it("removes old contact, adds new contact, and preserves the B-C hash", () => {
    const a = rectangle("a", 0, 1);
    const b = rectangle("b", 1, 2);
    const c = rectangle("c", 2, 3);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [c.id]: c});
    const beforeBC = internalHash(before.topology, b.id, c.id);
    const movedA = rectangle("a", 3, 4);
    const territories = {[a.id]: movedA, [b.id]: b, [c.id]: c};
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      territories,
      [a.id],
    );

    expect(result.topology.neighborTerritoryIdsById[a.id]).toEqual([c.id]);
    expect(result.topology.neighborTerritoryIdsById[a.id]).not.toContain(b.id);
    expect(result.topology.neighborTerritoryIdsById[b.id]).toEqual([c.id]);
    expect(internalHash(result.topology, b.id, c.id)).toBe(beforeBC);
    expect(result.topology).toEqual(buildCanonicalTopology(territories));
  });

  it("handles deletion, creation, changed-order, duplicates, and empty changes deterministically", () => {
    const a = rectangle("a", 0, 1);
    const b = rectangle("b", 1, 2);
    const remote = rectangle("remote", 20, 21);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [remote.id]: remote});
    const deleted = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[b.id]: b, [remote.id]: remote}, [a.id],
    );
    const createdA = rectangle("new-a", 2, 3);
    const created = recalculateTopologyIncrementally(
      deleted.topology,
      deleted.bboxIndex,
      {[b.id]: b, [createdA.id]: createdA, [remote.id]: remote},
      [createdA.id],
    );
    const orderOne = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[a.id]: a, [b.id]: b, [remote.id]: remote}, [a.id, b.id],
    );
    const orderTwo = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[a.id]: a, [b.id]: b, [remote.id]: remote}, [b.id, a.id, a.id],
    );
    const empty = recalculateTopologyIncrementally(
      before.topology, before.bboxIndex, {[a.id]: a, [b.id]: b, [remote.id]: remote}, [],
    );

    expect(Object.values(deleted.topology.edgesById).some(({territoryIds}) => territoryIds.includes(a.id))).toBe(false);
    expect(created.topology.neighborTerritoryIdsById[createdA.id]).toEqual([b.id]);
    expect(orderOne.recomputedTerritoryIds).toEqual(orderTwo.recomputedTerritoryIds);
    expect(Object.keys(orderOne.topology.edgesById)).toEqual(Object.keys(orderTwo.topology.edgesById));
    expect(empty.topology).toBe(before.topology);
    expect(empty.bboxIndex).toBe(before.bboxIndex);
  });
});
