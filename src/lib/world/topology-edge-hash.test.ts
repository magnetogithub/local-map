import {describe, expect, it} from "vitest";

import {topologyEdgeLeafHash} from "./topology-edge-hash";
import {deriveTerritoryId} from "./territory-id";
import type {TopologyEdge} from "./topology-state";

const alpha = deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId: "alpha"});
const beta = deriveTerritoryId({kind: "seed", seedVersion: "v2", sourceFeatureId: "beta"});
const [first, second] = [alpha, beta].sort();
const edge: TopologyEdge = {
  id: "topology-edge:alpha-beta" as TopologyEdge["id"],
  territoryIds: [first, second],
  classification: "internal",
  coordinates: [[-0, 0], [1, 1], [2, 1]],
};

describe("10-26 topologyEdge leaf hash", () => {
  it("is independent of Territory side order and coordinate direction", () => {
    const reversed = {
      ...edge,
      territoryIds: [second, first],
      coordinates: [...edge.coordinates].reverse(),
    } as unknown as TopologyEdge;

    expect(topologyEdgeLeafHash(edge)).toBe(topologyEdgeLeafHash(reversed));
  });

  it("changes for edge ID, classification, or geometry", () => {
    const hashes = [
      topologyEdgeLeafHash(edge),
      topologyEdgeLeafHash({...edge, id: "topology-edge:renamed" as TopologyEdge["id"]}),
      topologyEdgeLeafHash({...edge, classification: "coast"}),
      topologyEdgeLeafHash({...edge, coordinates: [[0, 0], [1, 2], [2, 1]]}),
    ];

    expect(new Set(hashes)).toHaveLength(4);
  });

  it("does not read mutable country owner order", () => {
    const firstOwners = {edge, ownerCountryIds: ["AAA", "BBB"]};
    const reversedOwners = {edge, ownerCountryIds: ["BBB", "AAA"]};

    expect(topologyEdgeLeafHash(firstOwners.edge)).toBe(
      topologyEdgeLeafHash(reversedOwners.edge),
    );
  });

  it("normalizes negative zero in line geometry", () => {
    expect(topologyEdgeLeafHash(edge)).toBe(
      topologyEdgeLeafHash({...edge, coordinates: [[0, 0], [1, 1], [2, 1]]}),
    );
  });
});
