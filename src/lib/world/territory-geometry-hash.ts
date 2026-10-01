import {
  normalizeCanonicalGeometry,
  type CanonicalGeometryPolicy,
} from "./canonical-geometry-serializer";
import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";
import type {TerritoryEntity} from "./territory-entity";

const TERRITORY_GEOMETRY_HASH_SCHEMA_VERSION = 1 as const;
const geometryHashCache = new WeakMap<object, Map<string, string>>();

/** Hashes policy-normalized Territory geometry without identity or ownership state. */
export function territoryGeometryLeafHash(
  territory: Pick<TerritoryEntity, "geometry">,
  policy: CanonicalGeometryPolicy,
): string {
  const policyKey = `${policy.coordinatePrecision}:${policy.exteriorRingWinding}`;
  const cached = geometryHashCache.get(territory.geometry)?.get(policyKey);
  if (cached) return cached;
  const hash = sha256Hex(
    canonicalSerialize({
      namespace: "territoryGeometry",
      schemaVersion: TERRITORY_GEOMETRY_HASH_SCHEMA_VERSION,
      geometry: normalizeCanonicalGeometry(territory.geometry, policy),
    }),
  );
  const hashes = geometryHashCache.get(territory.geometry) ?? new Map<string, string>();
  hashes.set(policyKey, hash);
  geometryHashCache.set(territory.geometry, hashes);
  return hash;
}
