import {
  normalizeCanonicalGeometry,
  type CanonicalGeometry,
  type CanonicalGeometryPolicy,
  type CanonicalLinearRing,
} from "./canonical-geometry-serializer";
import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";

export type TopologyGeometryPolicy = Readonly<{
  version: string;
  coordinatePrecision: number;
  exteriorRingWinding: CanonicalGeometryPolicy["exteriorRingWinding"];
  minimumRingArea: number;
}>;

export const DEFAULT_TOPOLOGY_GEOMETRY_POLICY: TopologyGeometryPolicy = Object.freeze({
  version: "topology-geometry-v1",
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise",
  minimumRingArea: 1e-12,
});

const policyKeys = [
  "coordinatePrecision",
  "exteriorRingWinding",
  "minimumRingArea",
  "version",
] as const;

function readPolicy(policy: TopologyGeometryPolicy): TopologyGeometryPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("Topology geometry policy must be an object");
  }
  const keys = Object.keys(policy).sort();
  if (keys.length !== policyKeys.length || keys.some((key, index) => key !== policyKeys[index])) {
    throw new TypeError("Topology geometry policy contains unknown or missing fields");
  }
  if (typeof policy.version !== "string" || policy.version.trim() !== policy.version || !policy.version) {
    throw new TypeError("Topology geometry policy version must be canonical text");
  }
  if (!Number.isInteger(policy.coordinatePrecision) || policy.coordinatePrecision < 0 || policy.coordinatePrecision > 15) {
    throw new RangeError("Topology geometry precision must be an integer from 0 to 15");
  }
  if (policy.exteriorRingWinding !== "counterclockwise" && policy.exteriorRingWinding !== "clockwise") {
    throw new TypeError("Topology geometry winding is invalid");
  }
  if (!Number.isFinite(policy.minimumRingArea) || policy.minimumRingArea < 0) {
    throw new RangeError("Topology geometry minimumRingArea must be finite and non-negative");
  }
  return Object.freeze({...policy});
}

const ringArea = (ring: CanonicalLinearRing) => Math.abs(
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2,
);

export function normalizeTopologyGeometry(
  geometry: unknown,
  selectedPolicy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): CanonicalGeometry {
  const policy = readPolicy(selectedPolicy);
  const normalized = normalizeCanonicalGeometry(geometry, {
    coordinatePrecision: policy.coordinatePrecision,
    exteriorRingWinding: policy.exteriorRingWinding,
  });
  const polygons = normalized.type === "Polygon" ? [normalized.coordinates] : normalized.coordinates;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ringArea(ring) < policy.minimumRingArea) {
        throw new RangeError("Topology geometry ring is smaller than minimumRingArea");
      }
    }
  }
  return normalized;
}

export function topologyGeometryHash(
  geometry: unknown,
  selectedPolicy: TopologyGeometryPolicy = DEFAULT_TOPOLOGY_GEOMETRY_POLICY,
): string {
  const policy = readPolicy(selectedPolicy);
  return sha256Hex(canonicalSerialize({
    namespace: "topologyGeometry",
    policy,
    geometry: normalizeTopologyGeometry(geometry, policy),
  }));
}
