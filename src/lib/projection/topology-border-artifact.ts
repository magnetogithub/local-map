import type {
  TopologyEdge,
  TopologyEdgeClassification,
  TopologyEdgeId,
  TopologyPosition,
  TopologyState,
} from "../world/topology-state";
import type {TerritoryId} from "../world/territory-id";

export type TopologyBorderArtifactKind = "border" | "coast";

export type TopologyBorderFeatureProperties = Readonly<{
  topologyEdgeId: TopologyEdgeId;
  territoryIds: readonly [TerritoryId, TerritoryId | null];
  classification: TopologyEdgeClassification;
  artifactKind: TopologyBorderArtifactKind;
  source: "canonical-topology-edge";
}>;

export type TopologyBorderFeature = Readonly<{
  type: "Feature";
  id: TopologyEdgeId;
  properties: TopologyBorderFeatureProperties;
  geometry: Readonly<{
    type: "LineString";
    coordinates: readonly TopologyPosition[];
  }>;
}>;

export type TopologyBorderArtifactProjection = Readonly<{
  revision: number;
  featuresByTopologyEdgeId: ReadonlyMap<TopologyEdgeId, TopologyBorderFeature>;
  borderFeatures: readonly TopologyBorderFeature[];
  coastFeatures: readonly TopologyBorderFeature[];
}>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const artifactKind = (classification: TopologyEdgeClassification): TopologyBorderArtifactKind =>
  classification === "internal" ? "border" : "coast";

export function createTopologyBorderFeature(edge: TopologyEdge): TopologyBorderFeature {
  return Object.freeze({
    type: "Feature" as const,
    id: edge.id,
    properties: Object.freeze({
      topologyEdgeId: edge.id,
      territoryIds: edge.territoryIds,
      classification: edge.classification,
      artifactKind: artifactKind(edge.classification),
      source: "canonical-topology-edge" as const,
    }),
    geometry: Object.freeze({
      type: "LineString" as const,
      coordinates: edge.coordinates,
    }),
  });
}

export function createTopologyBorderArtifactProjection(
  topology: TopologyState,
  revision: number,
): TopologyBorderArtifactProjection {
  const features = Object.values(topology.edgesById)
    .sort((left, right) => compareText(left.id, right.id))
    .map(createTopologyBorderFeature);
  const featuresByTopologyEdgeId = new Map<TopologyEdgeId, TopologyBorderFeature>(
    features.map((feature) => [feature.id, feature]),
  );
  return Object.freeze({
    revision,
    featuresByTopologyEdgeId,
    borderFeatures: Object.freeze(
      features.filter(({properties}) => properties.artifactKind === "border"),
    ),
    coastFeatures: Object.freeze(
      features.filter(({properties}) => properties.artifactKind === "coast"),
    ),
  });
}
