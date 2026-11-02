import {describe, expect, it} from "vitest";

import {buildCanonicalTopology} from "../world/canonical-topology";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import type {TopologyEdge} from "../world/topology-state";
import {
  createTopologyBorderArtifactProjection,
  createTopologyBorderFeature,
} from "./topology-border-artifact";

const rectangle = (x: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 1],
    [x, 0],
  ]],
});

const territory = (sourceFeatureId: string, geometry: TerritoryGeometry) => {
  const id = deriveTerritoryId({
    kind: "seed",
    seedVersion: "10-94-test",
    sourceFeatureId,
  });
  return createTerritoryEntity({
    id,
    ownerCountryId: null,
    geometry,
    properties: {sourceFeatureId},
  });
};

const sharedBorderWorld = () => {
  const west = territory("west", rectangle(0));
  const east = territory("east", rectangle(1));
  const topology = buildCanonicalTopology({[west.id]: west, [east.id]: east});
  return {west, east, topology};
};

const internalEdge = (edges: readonly TopologyEdge[]) => {
  const edge = edges.find(({classification}) => classification === "internal");
  if (!edge) throw new Error("internal edge fixture missing");
  return edge;
};

describe("10-94 topology border artifact projection", () => {
  it("creates border and coast features from canonical topology edges", () => {
    const {topology} = sharedBorderWorld();
    const projection = createTopologyBorderArtifactProjection(topology, 14);
    const edgeCount = Object.keys(topology.edgesById).length;

    expect(projection.revision).toBe(14);
    expect(projection.featuresByTopologyEdgeId.size).toBe(edgeCount);
    expect(projection.borderFeatures).toHaveLength(1);
    expect(projection.coastFeatures.length).toBeGreaterThan(0);
    expect([
      ...projection.borderFeatures,
      ...projection.coastFeatures,
    ].every(({properties}) => properties.source === "canonical-topology-edge")).toBe(true);
  });

  it("uses canonical edge coordinates instead of final polygon outlines", () => {
    const {topology, west} = sharedBorderWorld();
    const edge = internalEdge(Object.values(topology.edgesById));
    const feature = createTopologyBorderFeature(edge);

    expect(feature.properties.artifactKind).toBe("border");
    expect(feature.geometry.coordinates).toBe(edge.coordinates);
    expect(feature.geometry.coordinates).toEqual([[1, 0], [1, 1]]);
    expect(feature.geometry.coordinates).not.toEqual(west.geometry.coordinates[0]);
    expect(feature.geometry.coordinates).toHaveLength(2);
    expect(west.geometry.coordinates[0]).toHaveLength(5);
  });
});
