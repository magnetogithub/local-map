import {canonicalSerialize} from "./canonical-serializer";
import {topologyHasWorldSpanningEdge} from "./canonical-topology";
import {sha256Hex} from "./sha256";
import {topologyEdgeLeafHash} from "./topology-edge-hash";
import type {TopologyState} from "./topology-state";
import type {TerritoryEntity} from "./territory-entity";
import {atomizeTopologySegments, canonicalizeTopologySegment, topologySegmentKey} from "./shared-segment";

export type SeedTopologyAudit = Readonly<{
  edgeCount: number;
  internalEdgeCount: number;
  coastEdgeCount: number;
  duplicateEdgeCount: 0;
  worldSpanningEdgeCount: 0;
  topologyHash: string;
}>;

export function auditSeedTopology(
  topology: TopologyState,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
): SeedTopologyAudit {
  const edges = Object.values(topology.edgesById);
  const ids = new Set(edges.map(({id}) => id));
  if (ids.size !== edges.length) throw new Error("Seed topology contains duplicate edge IDs");
  if (topologyHasWorldSpanningEdge(topology)) {
    throw new Error("Seed topology contains a world-spanning edge");
  }
  const internalEdgeCount = edges.filter(({classification}) => classification === "internal").length;
  const coastEdgeCount = edges.filter(({classification}) => classification === "coast").length;
  if (internalEdgeCount + coastEdgeCount !== edges.length) {
    throw new Error("Seed topology contains an unclassified edge");
  }
  const expectedNeighbors = new Map<string, Set<string>>();
  const internalSegmentKeys = new Set<string>();
  const coastSegmentKeys = new Set<string>();
  for (const edge of edges) {
    const [first, second] = edge.territoryIds;
    if (!expectedNeighbors.has(first)) expectedNeighbors.set(first, new Set());
    if (edge.classification === "internal") {
      if (second === null) throw new Error("Seed internal edge must have exactly two Territories");
      if (!expectedNeighbors.has(second)) expectedNeighbors.set(second, new Set());
      expectedNeighbors.get(first)!.add(second);
      expectedNeighbors.get(second)!.add(first);
    } else if (second !== null) {
      throw new Error("Seed coast edge must have one Territory and a null side");
    }
    for (let index = 1; index < edge.coordinates.length; index += 1) {
      const key = topologySegmentKey(canonicalizeTopologySegment(
        edge.coordinates[index - 1],
        edge.coordinates[index],
      ));
      (edge.classification === "internal" ? internalSegmentKeys : coastSegmentKeys).add(key);
    }
  }
  const suppliedNeighborKeys = Object.keys(topology.neighborTerritoryIdsById).sort();
  const expectedNeighborKeys = [...expectedNeighbors.keys()].sort();
  if (JSON.stringify(suppliedNeighborKeys) !== JSON.stringify(expectedNeighborKeys)) {
    throw new Error("Seed neighbor index keys do not match topology edges");
  }
  for (const territoryId of expectedNeighborKeys) {
    const expected = [...expectedNeighbors.get(territoryId)!].sort();
    if (JSON.stringify(topology.neighborTerritoryIdsById[territoryId]) !== JSON.stringify(expected)) {
      throw new Error(`Seed neighbor index does not match internal edges for ${territoryId}`);
    }
  }
  const atomicOccurrences = atomizeTopologySegments(Object.values(territoriesById).map((territory) => ({
    ownerKey: territory.id,
    geometry: territory.geometry,
  })));
  for (const {segment, ownerKeys} of atomicOccurrences) {
    if (ownerKeys.length !== 2) continue;
    const key = topologySegmentKey(segment);
    if (!internalSegmentKeys.has(key) || coastSegmentKeys.has(key)) {
      throw new Error("Seed shared border remains classified as coast or is missing internally");
    }
  }
  const leafHashes = edges.map(topologyEdgeLeafHash).sort();
  return Object.freeze({
    edgeCount: edges.length,
    internalEdgeCount,
    coastEdgeCount,
    duplicateEdgeCount: 0,
    worldSpanningEdgeCount: 0,
    topologyHash: sha256Hex(canonicalSerialize({namespace: "seedTopology", leafHashes})),
  });
}
