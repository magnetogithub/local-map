import {
  buildCanonicalTopology,
  deriveCanonicalTopologyEdgeId,
  mergeCanonicalTopologySegments,
} from "./canonical-topology";
import {
  createTerritoryBBoxIndex,
  queryTerritoryBBoxCandidates,
  updateTerritoryBBoxIndex,
  type TerritoryBBoxIndex,
} from "./territory-bbox-index";
import type {TerritoryEntity} from "./territory-entity";
import type {TerritoryId} from "./territory-id";
import {
  atomizeCanonicalTopologySegments,
  canonicalizeTopologySegment,
  type CanonicalTopologySegment,
} from "./shared-segment";
import {
  DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
  type TopologyGeometryPolicy,
} from "./topology-geometry-policy";
import {
  createTopologyState,
  type TopologyEdge,
  type TopologyState,
} from "./topology-state";

export type IncrementalTopologyResult = Readonly<{
  topology: TopologyState;
  bboxIndex: TerritoryBBoxIndex;
  recomputedTerritoryIds: readonly TerritoryId[];
}>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const edgeSegments = (edge: TopologyEdge): CanonicalTopologySegment[] => {
  const segments: CanonicalTopologySegment[] = [];
  for (let index = 1; index < edge.coordinates.length; index += 1) {
    segments.push(canonicalizeTopologySegment(
      edge.coordinates[index - 1],
      edge.coordinates[index],
    ));
  }
  return segments;
};

const addCoastSegments = (
  byTerritoryId: Map<TerritoryId, CanonicalTopologySegment[]>,
  territoryId: TerritoryId,
  segments: readonly CanonicalTopologySegment[],
) => {
  const current = byTerritoryId.get(territoryId) ?? [];
  current.push(...segments);
  byTerritoryId.set(territoryId, current);
};

const partitionSegments = (
  source: readonly CanonicalTopologySegment[],
  excluded: readonly CanonicalTopologySegment[],
  policy: TopologyGeometryPolicy,
) => {
  const atomics = atomizeCanonicalTopologySegments([
    {ownerKey: "excluded", segments: excluded},
    {ownerKey: "source", segments: source},
  ], policy);
  return {
    remaining: atomics
      .filter(({ownerKeys}) => ownerKeys.length === 1 && ownerKeys[0] === "source")
      .map(({segment}) => segment),
    hasOverlap: atomics.some(({ownerKeys}) => ownerKeys.length === 2),
  };
};

const preserveEdgeReferences = (
  topology: TopologyState,
  preservedEdges: readonly TopologyEdge[],
): TopologyState => {
  const preservedById = new Map(preservedEdges.map((edge) => [edge.id, edge]));
  const edgesById = Object.fromEntries(Object.entries(topology.edgesById).map(([edgeId, edge]) => [
    edgeId,
    preservedById.get(edge.id) ?? edge,
  ]));
  return Object.freeze({
    edgesById: Object.freeze(edgesById),
    neighborTerritoryIdsById: topology.neighborTerritoryIdsById,
  });
};

export function recalculateTopologyIncrementally(
  previousTopology: TopologyState,
  previousBBoxIndex: TerritoryBBoxIndex,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
  changedTerritoryIds: Iterable<TerritoryId>,
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): IncrementalTopologyResult {
  const changed = [...new Set(changedTerritoryIds)].sort(compareText);
  if (changed.length === 0) {
    return Object.freeze({
      topology: previousTopology,
      bboxIndex: previousBBoxIndex,
      recomputedTerritoryIds: Object.freeze([]),
    });
  }
  const nextBBoxIndex = updateTerritoryBBoxIndex(previousBBoxIndex, territoriesById, changed);
  const recomputed = new Set<TerritoryId>(changed);
  for (const territoryId of changed) {
    for (const candidate of [
      ...queryTerritoryBBoxCandidates(previousBBoxIndex, territoryId),
      ...queryTerritoryBBoxCandidates(nextBBoxIndex, territoryId),
    ]) recomputed.add(candidate);
  }

  const affectedTerritories = Object.fromEntries(
    [...recomputed]
      .filter((territoryId) => territoriesById[territoryId] !== undefined)
      .sort(compareText)
      .map((territoryId) => [territoryId, territoriesById[territoryId]]),
  );
  const rebuilt = buildCanonicalTopology(affectedTerritories, policy);
  const changedSet = new Set(changed);
  const rebuiltEdges = Object.values(rebuilt.edgesById);
  const newInternalEdges = rebuiltEdges.filter((edge) =>
    edge.classification === "internal" &&
    edge.territoryIds.some((territoryId) => territoryId !== null && changedSet.has(territoryId))
  );
  const newSharedSegments = newInternalEdges.flatMap(edgeSegments);
  const coastSegmentsToRebuild = new Map<TerritoryId, CanonicalTopologySegment[]>();
  const preservedEdges: TopologyEdge[] = [];
  const territoriesNeedingCoastRebuild = new Set<TerritoryId>();

  for (const edge of Object.values(previousTopology.edgesById)) {
    if (edge.classification === "coast") {
      const territoryId = edge.territoryIds[0];
      if (!changedSet.has(territoryId) && recomputed.has(territoryId) &&
        partitionSegments(edgeSegments(edge), newSharedSegments, policy).hasOverlap) {
        territoriesNeedingCoastRebuild.add(territoryId);
      }
      continue;
    }
    const containsChanged = edge.territoryIds.some((territoryId) =>
      territoryId !== null && changedSet.has(territoryId)
    );
    if (!containsChanged) continue;
    const partition = partitionSegments(edgeSegments(edge), newSharedSegments, policy);
    if (partition.remaining.length === 0) continue;
    for (const territoryId of edge.territoryIds) {
      if (territoryId !== null && !changedSet.has(territoryId)) {
        territoriesNeedingCoastRebuild.add(territoryId);
      }
    }
  }

  for (const edge of Object.values(previousTopology.edgesById)) {
    const containsChanged = edge.territoryIds.some((territoryId) =>
      territoryId !== null && changedSet.has(territoryId)
    );
    if (edge.classification === "internal") {
      if (!containsChanged) {
        preservedEdges.push(edge);
        continue;
      }
      for (const territoryId of edge.territoryIds) {
        if (territoryId === null || changedSet.has(territoryId)) continue;
        const partition = partitionSegments(edgeSegments(edge), newSharedSegments, policy);
        addCoastSegments(
          coastSegmentsToRebuild,
          territoryId,
          partition.remaining,
        );
      }
      continue;
    }
    const territoryId = edge.territoryIds[0];
    if (changedSet.has(territoryId)) continue;
    if (!recomputed.has(territoryId)) {
      preservedEdges.push(edge);
      continue;
    }
    if (!territoriesNeedingCoastRebuild.has(territoryId)) {
      preservedEdges.push(edge);
      continue;
    }
    addCoastSegments(
      coastSegmentsToRebuild,
      territoryId,
      partitionSegments(edgeSegments(edge), newSharedSegments, policy).remaining,
    );
  }

  const changedCoastEdges = rebuiltEdges.filter((edge) =>
    edge.classification === "coast" && changedSet.has(edge.territoryIds[0])
  );
  const rebuiltCandidateCoastEdges: TopologyEdge[] = [];
  for (const [territoryId, segments] of coastSegmentsToRebuild) {
    const normalizedSegments = atomizeCanonicalTopologySegments([
      {ownerKey: territoryId, segments},
    ], policy).map(({segment}) => segment);
    for (const coordinates of mergeCanonicalTopologySegments(normalizedSegments)) {
      const sides = Object.freeze([territoryId, null]) as readonly [TerritoryId, null];
      rebuiltCandidateCoastEdges.push(Object.freeze({
        id: deriveCanonicalTopologyEdgeId(sides, coordinates),
        territoryIds: sides,
        classification: "coast",
        coordinates,
      }));
    }
  }
  const topology = createTopologyState([
      ...preservedEdges,
      ...newInternalEdges,
      ...changedCoastEdges,
      ...rebuiltCandidateCoastEdges,
    ]);
  return Object.freeze({
    topology: preserveEdgeReferences(topology, preservedEdges),
    bboxIndex: nextBBoxIndex,
    recomputedTerritoryIds: Object.freeze([...recomputed].sort(compareText)),
  });
}

export function initializeIncrementalTopology(
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): IncrementalTopologyResult {
  return Object.freeze({
    topology: buildCanonicalTopology(territoriesById, policy),
    bboxIndex: createTerritoryBBoxIndex(territoriesById),
    recomputedTerritoryIds: Object.freeze(Object.values(territoriesById).map(({id}) => id).sort(compareText)),
  });
}
