import {
  normalizeCanonicalGeometry,
  type CanonicalGeometryPolicy,
} from "./canonical-geometry-serializer";
import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";
import type {TerritoryEntity} from "./territory-entity";

const TERRITORY_GEOMETRY_HASH_SCHEMA_VERSION = 1 as const;

/** Hashes policy-normalized Territory geometry without identity or ownership state. */
export function territoryGeometryLeafHash(
  territory: Pick<TerritoryEntity, "geometry">,
  policy: CanonicalGeometryPolicy,
): string {
  return sha256Hex(
    canonicalSerialize({
      namespace: "territoryGeometry",
      schemaVersion: TERRITORY_GEOMETRY_HASH_SCHEMA_VERSION,
      geometry: normalizeCanonicalGeometry(territory.geometry, policy),
    }),
  );
}
