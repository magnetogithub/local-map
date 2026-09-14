import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";
import type {TerritoryId} from "./territory-id";
import type {TopologyEdge, TopologyPosition} from "./topology-state";

const TOPOLOGY_EDGE_HASH_SCHEMA_VERSION = 1 as const;

const normalizeNumber = (value: number) => (Object.is(value, -0) ? 0 : value);

const comparePositions = (left: TopologyPosition, right: TopologyPosition) =>
  left[0] < right[0]
    ? -1
    : left[0] > right[0]
      ? 1
      : left[1] < right[1]
        ? -1
        : left[1] > right[1]
          ? 1
          : 0;

const compareSequences = (
  left: readonly TopologyPosition[],
  right: readonly TopologyPosition[],
) => {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = comparePositions(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

function canonicalCoordinates(value: readonly TopologyPosition[]): readonly TopologyPosition[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new TypeError("Topology edge hash requires at least two coordinate positions");
  }
  const forward = value.map((position, index) => {
    if (
      !Array.isArray(position) ||
      position.length !== 2 ||
      position.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
    ) {
      throw new TypeError(`Topology edge coordinate ${index} must contain two finite numbers`);
    }
    return [normalizeNumber(position[0]), normalizeNumber(position[1])] as TopologyPosition;
  });
  const reverse = [...forward].reverse();
  return compareSequences(forward, reverse) <= 0 ? forward : reverse;
}

function canonicalTerritorySides(
  territoryIds: readonly [TerritoryId, TerritoryId | null],
): readonly [TerritoryId, TerritoryId | null] {
  const [first, second] = territoryIds;
  if (second === null) return [first, null];
  return first < second ? [first, second] : [second, first];
}

/** Hashes canonical topology identity without deriving any country ownership. */
export function topologyEdgeLeafHash(edge: TopologyEdge): string {
  return sha256Hex(
    canonicalSerialize({
      namespace: "topologyEdge",
      schemaVersion: TOPOLOGY_EDGE_HASH_SCHEMA_VERSION,
      edgeId: edge.id,
      territoryIds: canonicalTerritorySides(edge.territoryIds),
      classification: edge.classification,
      coordinates: canonicalCoordinates(edge.coordinates),
    }),
  );
}
