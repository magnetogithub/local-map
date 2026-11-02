import {canonicalStringify} from "./canonical-serializer";
import {territoryBBoxesIntersect, calculateTerritoryBBox} from "./territory-bbox-index";
import type {TerritoryGeometry} from "./territory-entity";
import {
  DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
  normalizeTopologyGeometry,
  type TopologyGeometryPolicy,
} from "./topology-geometry-policy";
import type {TopologyPosition} from "./topology-state";

export type CanonicalTopologySegment = readonly [TopologyPosition, TopologyPosition];
export type TopologySegmentOwnerInput = Readonly<{
  ownerKey: string;
  geometry: TerritoryGeometry;
}>;
export type CanonicalSegmentOwnerInput = Readonly<{
  ownerKey: string;
  segments: readonly CanonicalTopologySegment[];
}>;
export type AtomicTopologySegmentOccurrence = Readonly<{
  segment: CanonicalTopologySegment;
  ownerKeys: readonly string[];
}>;

const comparePosition = (left: TopologyPosition, right: TopologyPosition) =>
  left[0] - right[0] || left[1] - right[1];
const normalizeLongitude = (longitude: number) => {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
};

export function canonicalizeTopologySegment(
  first: TopologyPosition,
  second: TopologyPosition,
): CanonicalTopologySegment {
  let firstLongitude = normalizeLongitude(first[0]);
  let secondLongitude = normalizeLongitude(second[0]);
  if (secondLongitude - firstLongitude > 180) secondLongitude -= 360;
  if (secondLongitude - firstLongitude < -180) secondLongitude += 360;
  let positions: [TopologyPosition, TopologyPosition] = [
    Object.freeze([firstLongitude, first[1]]) as TopologyPosition,
    Object.freeze([secondLongitude, second[1]]) as TopologyPosition,
  ];
  if (comparePosition(positions[0], positions[1]) > 0) positions = [positions[1], positions[0]];
  while (positions[0][0] < -180) {
    firstLongitude = positions[0][0] + 360;
    secondLongitude = positions[1][0] + 360;
    positions = [Object.freeze([firstLongitude, positions[0][1]]), Object.freeze([secondLongitude, positions[1][1]])];
  }
  while (positions[0][0] >= 180) {
    firstLongitude = positions[0][0] - 360;
    secondLongitude = positions[1][0] - 360;
    positions = [Object.freeze([firstLongitude, positions[0][1]]), Object.freeze([secondLongitude, positions[1][1]])];
  }
  return Object.freeze(positions);
}

export const topologySegmentKey = (segment: CanonicalTopologySegment) => canonicalStringify(segment);

const roundForLineKey = (value: number, precision: number) => {
  const rounded = Number(value.toFixed(Math.min(15, precision + 6)));
  return Object.is(rounded, -0) ? 0 : rounded;
};

function segmentVariants(segment: CanonicalTopologySegment): CanonicalTopologySegment[] {
  const variants = [segment];
  if (segment.some(([longitude]) => Math.abs(longitude) >= 170 || Math.abs(longitude) > 180)) {
    for (const shift of [-360, 360]) {
      variants.push(Object.freeze(segment.map(([longitude, latitude]) =>
        Object.freeze([longitude + shift, latitude]) as TopologyPosition
      )) as unknown as CanonicalTopologySegment);
    }
  }
  return variants;
}

function lineProjection(
  segment: CanonicalTopologySegment,
  precision: number,
) {
  const [first, second] = segment;
  const dx = second[0] - first[0];
  const dy = second[1] - first[1];
  if (Math.abs(dx) >= Math.abs(dy)) {
    const slope = dy / dx;
    return {
      key: `x:${roundForLineKey(slope, precision)}:${roundForLineKey(first[1] - slope * first[0], precision)}`,
      firstT: first[0],
      secondT: second[0],
    };
  }
  const slope = dx / dy;
  return {
    key: `y:${roundForLineKey(slope, precision)}:${roundForLineKey(first[0] - slope * first[1], precision)}`,
    firstT: first[1],
    secondT: second[1],
  };
}

export function atomizeTopologySegments(
  inputs: readonly TopologySegmentOwnerInput[],
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): readonly AtomicTopologySegmentOccurrence[] {
  return atomizeCanonicalTopologySegments(inputs.map((input) => ({
    ownerKey: input.ownerKey,
    segments: extractTopologySegments(input.geometry, policy),
  })), policy);
}

export function atomizeCanonicalTopologySegments(
  inputs: readonly CanonicalSegmentOwnerInput[],
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): readonly AtomicTopologySegmentOccurrence[] {
  const lines = new Map<string, Array<{
    ownerKey: string;
    segment: CanonicalTopologySegment;
    minT: number;
    maxT: number;
    firstT: number;
    secondT: number;
  }>>();
  for (const input of [...inputs].sort((left, right) => left.ownerKey < right.ownerKey ? -1 : left.ownerKey > right.ownerKey ? 1 : 0)) {
    for (const segment of input.segments) {
      for (const variant of segmentVariants(segment)) {
        const projection = lineProjection(variant, policy.coordinatePrecision);
        const entries = lines.get(projection.key) ?? [];
        entries.push({
          ownerKey: input.ownerKey,
          segment: variant,
          minT: Math.min(projection.firstT, projection.secondT),
          maxT: Math.max(projection.firstT, projection.secondT),
          firstT: projection.firstT,
          secondT: projection.secondT,
        });
        lines.set(projection.key, entries);
      }
    }
  }

  const atomics = new Map<string, {segment: CanonicalTopologySegment; ownerKeys: Set<string>}>();
  for (const entries of lines.values()) {
    const pointByT = new Map<number, TopologyPosition>();
    for (const entry of entries) {
      pointByT.set(entry.firstT, entry.segment[0]);
      pointByT.set(entry.secondT, entry.segment[1]);
    }
    const breakpoints = [...pointByT.keys()].sort((left, right) => left - right);
    for (let index = 0; index < breakpoints.length - 1; index += 1) {
      const startT = breakpoints[index];
      const endT = breakpoints[index + 1];
      if (endT <= startT) continue;
      const midpoint = (startT + endT) / 2;
      const owners = new Set(entries
        .filter(({minT, maxT}) => minT < midpoint && midpoint < maxT)
        .map(({ownerKey}) => ownerKey));
      if (owners.size === 0) continue;
      const segment = canonicalizeTopologySegment(pointByT.get(startT)!, pointByT.get(endT)!);
      if (segment[0][0] === segment[1][0] && segment[0][1] === segment[1][1]) continue;
      const key = topologySegmentKey(segment);
      const existing = atomics.get(key) ?? {segment, ownerKeys: new Set<string>()};
      for (const owner of owners) existing.ownerKeys.add(owner);
      atomics.set(key, existing);
    }
  }
  return Object.freeze([...atomics.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, occurrence]) => Object.freeze({
      segment: occurrence.segment,
      ownerKeys: Object.freeze([...occurrence.ownerKeys].sort()),
    })));
}

export function extractTopologySegments(
  geometry: TerritoryGeometry,
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): readonly CanonicalTopologySegment[] {
  const normalized = normalizeTopologyGeometry(geometry, policy);
  const polygons = normalized.type === "Polygon" ? [normalized.coordinates] : normalized.coordinates;
  const byKey = new Map<string, CanonicalTopologySegment>();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length - 1; index += 1) {
        const segment = canonicalizeTopologySegment(ring[index], ring[index + 1]);
        if (segment[0][0] === segment[1][0] && segment[0][1] === segment[1][1]) continue;
        byKey.set(topologySegmentKey(segment), segment);
      }
    }
  }
  return Object.freeze([...byKey.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, segment]) => segment));
}

export function extractSharedTopologySegments(
  left: TerritoryGeometry,
  right: TerritoryGeometry,
  policy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): readonly CanonicalTopologySegment[] {
  if (!territoryBBoxesIntersect(calculateTerritoryBBox(left), calculateTerritoryBBox(right))) return Object.freeze([]);
  return Object.freeze(atomizeTopologySegments([
    {ownerKey: "left", geometry: left},
    {ownerKey: "right", geometry: right},
  ], policy).filter(({ownerKeys}) => ownerKeys.length === 2).map(({segment}) => segment));
}
