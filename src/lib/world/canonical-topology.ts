import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";
import {
  atomizeTopologySegments,
  canonicalizeTopologySegment,
  type CanonicalTopologySegment,
} from "./shared-segment";
import type {TerritoryEntity} from "./territory-entity";
import type {TerritoryId} from "./territory-id";
import {
  DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
  type TopologyGeometryPolicy,
} from "./topology-geometry-policy";
import {
  createTopologyState,
  type TopologyEdge,
  type TopologyEdgeId,
  type TopologyState,
} from "./topology-state";

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const ringArea = (ring: readonly (readonly [number, number])[]) => Math.abs(
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2,
);

const territoryArea = (territory: TerritoryEntity) => {
  const polygons = territory.geometry.type === "Polygon"
    ? [territory.geometry.coordinates]
    : territory.geometry.coordinates;
  return polygons.reduce((total, polygon) => total + Math.max(
    0,
    ringArea(polygon[0]) - polygon.slice(1).reduce((sum, hole) => sum + ringArea(hole), 0),
  ), 0);
};

function resolveCoincidentTerritoryOwners(
  territoryIds: readonly TerritoryId[],
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
): TerritoryId[] {
  if (territoryIds.length <= 2) return [...territoryIds];
  const byCountry = new Map<string, TerritoryId[]>();
  for (const territoryId of territoryIds) {
    const ownerKey = territoriesById[territoryId].ownerCountryId ?? "__unclaimed__";
    byCountry.set(ownerKey, [...(byCountry.get(ownerKey) ?? []), territoryId]);
  }
  if (byCountry.size > 2) {
    throw new Error(`A canonical topology segment cannot belong to more than two country owners: ${[...byCountry.keys()].join(",")}`);
  }
  return [...byCountry.values()].map((candidates) => [...candidates].sort((left, right) =>
    territoryArea(territoriesById[left]) - territoryArea(territoriesById[right])
    || compareText(left, right))[0]).sort(compareText);
}

export function deriveCanonicalTopologyEdgeId(
  territoryIds: readonly [TerritoryId, TerritoryId | null],
  coordinates: readonly (readonly [number, number])[],
): TopologyEdgeId {
  const secondTerritoryId = territoryIds[1];
  const sides = secondTerritoryId === null
    ? territoryIds
    : [territoryIds[0], secondTerritoryId].sort(compareText) as [TerritoryId, TerritoryId];
  const forward = [...coordinates];
  const reverse = [...coordinates].reverse();
  const normalizedCoordinates = coordinates.length === 2
    ? canonicalizeTopologySegment(coordinates[0], coordinates[1])
    : JSON.stringify(forward) <= JSON.stringify(reverse) ? forward : reverse;
  const digest = sha256Hex(canonicalSerialize({
    namespace: "canonicalTopologyEdge",
    territoryIds: sides,
    coordinates: normalizedCoordinates,
  }));
  return `topology-edge:${digest}` as TopologyEdgeId;
}

const pointKey = (position: readonly [number, number]) => {
  const longitude = ((position[0] + 180) % 360 + 360) % 360 - 180;
  return `${Object.is(longitude, -0) ? 0 : longitude}:${position[1]}`;
};

export function mergeCanonicalTopologySegments(
  segments: readonly CanonicalTopologySegment[],
): readonly (readonly (readonly [number, number])[])[] {
  const adjacency = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const position of segment) {
      const key = pointKey(position);
      const indexes = adjacency.get(key) ?? [];
      indexes.push(index);
      adjacency.set(key, indexes);
    }
  });
  const unused = new Set(segments.map((_, index) => index));
  const paths: Array<readonly (readonly [number, number])[]> = [];
  const walk = (startIndex: number, startKey: string) => {
    const coordinates: Array<readonly [number, number]> = [];
    let index = startIndex;
    let currentKey = startKey;
    while (unused.has(index)) {
      unused.delete(index);
      const segment = segments[index];
      const firstKey = pointKey(segment[0]);
      const next = firstKey === currentKey ? segment[1] : segment[0];
      const previous = coordinates.at(-1);
      if (!previous) {
        const start = firstKey === currentKey ? segment[0] : segment[1];
        coordinates.push(start);
      }
      let longitude = next[0];
      const lastLongitude = coordinates.at(-1)![0];
      while (longitude - lastLongitude > 180) longitude -= 360;
      while (longitude - lastLongitude < -180) longitude += 360;
      coordinates.push(Object.freeze([longitude, next[1]]));
      currentKey = pointKey(next);
      const candidates = (adjacency.get(currentKey) ?? []).filter((candidate) => unused.has(candidate));
      if ((adjacency.get(currentKey)?.length ?? 0) !== 2 || candidates.length === 0) break;
      index = candidates[0];
    }
    const reverse = [...coordinates].reverse();
    const canonical = JSON.stringify(coordinates) <= JSON.stringify(reverse) ? coordinates : reverse;
    paths.push(Object.freeze(canonical));
  };
  for (const [key, indexes] of adjacency) {
    if (indexes.length === 2) continue;
    for (const index of indexes) if (unused.has(index)) walk(index, key);
  }
  while (unused.size > 0) {
    const index = unused.values().next().value as number;
    walk(index, pointKey(segments[index][0]));
  }
  return Object.freeze(paths);
}

export function buildCanonicalTopology(
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): TopologyState {
  const segmentsBySides = new Map<string, {
    territoryIds: readonly [TerritoryId, TerritoryId | null];
    segments: CanonicalTopologySegment[];
  }>();
  const occurrences = atomizeTopologySegments(Object.keys(territoriesById).map((territoryId) => ({
    ownerKey: territoryId,
    geometry: territoriesById[territoryId].geometry,
  })), policy);
  for (const occurrence of occurrences) {
    const territoryIds = resolveCoincidentTerritoryOwners(
      occurrence.ownerKeys as TerritoryId[],
      territoriesById,
    );
    const sides = Object.freeze([
      territoryIds[0],
      territoryIds[1] ?? null,
    ]) as readonly [TerritoryId, TerritoryId | null];
    const sideKey = JSON.stringify(sides);
    const group = segmentsBySides.get(sideKey) ?? {territoryIds: sides, segments: []};
    group.segments.push(occurrence.segment);
    segmentsBySides.set(sideKey, group);
  }
  const edges: TopologyEdge[] = [];
  for (const [, group] of [...segmentsBySides.entries()].sort(([left], [right]) => compareText(left, right))) {
    for (const coordinates of mergeCanonicalTopologySegments(group.segments)) {
      edges.push(Object.freeze({
        id: deriveCanonicalTopologyEdgeId(group.territoryIds, coordinates),
        territoryIds: group.territoryIds,
        classification: group.territoryIds[1] === null ? "coast" : "internal",
        coordinates,
      }));
    }
  }
  return createTopologyState(edges);
}

export function topologyHasWorldSpanningEdge(topology: TopologyState): boolean {
  return Object.values(topology.edgesById).some((edge) =>
    edge.coordinates.some((position, index) =>
      index > 0 && Math.abs(position[0] - edge.coordinates[index - 1][0]) > 180
    )
  );
}
