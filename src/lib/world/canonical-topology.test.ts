import {describe, expect, it} from "vitest";

import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {createTerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {
  buildCanonicalTopology,
  deriveCanonicalTopologyEdgeId,
  topologyHasWorldSpanningEdge,
} from "./canonical-topology";
import {canonicalizeTopologySegment} from "./shared-segment";

const territory = (name: string, coordinates: readonly (readonly [number, number])[]) => createTerritoryEntity({
  id: deriveTerritoryId({kind: "seed", seedVersion: "topology-v1", sourceFeatureId: name}),
  ownerCountryId: null,
  geometry: {type: "Polygon", coordinates: [coordinates]},
  properties: {},
});
const square = (name: string, minX: number, minY: number) => territory(name, [
  [minX, minY], [minX + 1, minY], [minX + 1, minY + 1],
  [minX, minY + 1], [minX, minY],
]);

const ownedSquare = (name: string, minX: number, minY: number, ownerCountryId: string) =>
  createTerritoryEntity({
    ...square(name, minX, minY),
    ownerCountryId: ownerCountryId as never,
  });

describe("10-49~10-53 canonical topology", () => {
  it("distinguishes shared segments from point contact and derives symmetric neighbors", () => {
    const alpha = square("alpha", 0, 0);
    const beta = square("beta", 1, 0);
    const point = square("point", 2, 1);
    const topology = buildCanonicalTopology({[point.id]: point, [beta.id]: beta, [alpha.id]: alpha});

    expect(topology.neighborTerritoryIdsById[alpha.id]).toEqual([beta.id]);
    expect(topology.neighborTerritoryIdsById[beta.id]).toEqual([alpha.id]);
    expect(topology.neighborTerritoryIdsById[point.id]).toEqual([]);
  });

  it("creates order-independent edge IDs and stores a shared edge once", () => {
    const alpha = square("alpha", 0, 0);
    const beta = square("beta", 1, 0);
    const segment = canonicalizeTopologySegment([1, 0], [1, 1]);
    const topology = buildCanonicalTopology({[alpha.id]: alpha, [beta.id]: beta});
    const internal = Object.values(topology.edgesById).filter(({classification}) => classification === "internal");

    expect(deriveCanonicalTopologyEdgeId([alpha.id, beta.id], segment)).toBe(
      deriveCanonicalTopologyEdgeId([beta.id, alpha.id], [segment[1], segment[0]]),
    );
    expect(internal).toHaveLength(1);
    expect(new Set(internal.map(topologyEdgeLeafHash))).toHaveLength(1);
  });

  it("classifies only one-sided segments as coast", () => {
    const alpha = square("alpha", 0, 0);
    const beta = square("beta", 1, 0);
    const edges = Object.values(buildCanonicalTopology({[alpha.id]: alpha, [beta.id]: beta}).edgesById);

    expect(edges.filter(({classification}) => classification === "internal")).toHaveLength(1);
    expect(edges.filter(({classification}) => classification === "coast")).toHaveLength(2);
    expect(edges.find(({classification}) => classification === "internal")?.territoryIds[1]).not.toBeNull();
  });

  it("keeps dateline segments short while retaining adjacency", () => {
    const north = territory("north", [[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]]);
    const south = territory("south", [[179, -1], [-179, -1], [-179, 0], [179, 0], [179, -1]]);
    const topology = buildCanonicalTopology({[north.id]: north, [south.id]: south});

    expect(topology.neighborTerritoryIdsById[north.id]).toEqual([south.id]);
    expect(topologyHasWorldSpanningEdge(topology)).toBe(false);
  });

  it("resolves coincident same-country boundary slivers to one territory side", () => {
    const large = createTerritoryEntity({
      ...ownedSquare("large", 0, 0, "AAA"),
      geometry: {type: "Polygon", coordinates: [[
        [0, 0], [1, 0], [1, 2], [0, 2], [0, 0],
      ]]},
    });
    const small = ownedSquare("small", 0, 0, "AAA");
    const neighbor = ownedSquare("neighbor", 1, 0, "BBB");
    const topology = buildCanonicalTopology({
      [large.id]: large,
      [small.id]: small,
      [neighbor.id]: neighbor,
    });
    const shared = Object.values(topology.edgesById).find((edge) =>
      edge.territoryIds.includes(neighbor.id)
      && edge.coordinates.some(([longitude]) => longitude === 1));

    expect(shared?.territoryIds).toContain(small.id);
    expect(shared?.territoryIds).not.toContain(large.id);
  });
});
