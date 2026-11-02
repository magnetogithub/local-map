import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";
import type {TerritoryEntity} from "./territory-entity";

const TERRITORY_OWNERSHIP_HASH_SCHEMA_VERSION = 1 as const;

/** Hashes Territory identity and its single effective owner without geometry or properties. */
export function territoryOwnershipLeafHash(
  territory: Pick<TerritoryEntity, "id" | "ownerCountryId">,
): string {
  return sha256Hex(
    canonicalSerialize({
      namespace: "territoryOwnership",
      schemaVersion: TERRITORY_OWNERSHIP_HASH_SCHEMA_VERSION,
      territoryId: territory.id,
      ownerCountryId: territory.ownerCountryId,
    }),
  );
}
