import {canonicalSerialize} from "./canonical-serializer";
import type {CountryEntity} from "./country-entity";
import {sha256Hex} from "./sha256";

const COUNTRY_CORE_HASH_SCHEMA_VERSION = 1 as const;

/** Hashes only CountryEntity core data; presentation and Territory state are excluded. */
export function countryCoreLeafHash(country: CountryEntity): string {
  return sha256Hex(
    canonicalSerialize({
      namespace: "countryCore",
      schemaVersion: COUNTRY_CORE_HASH_SCHEMA_VERSION,
      country: {
        id: country.id,
        names: {
          shortKo: country.names.shortKo,
          officialKo: country.names.officialKo,
          mapKo: country.names.mapKo,
          english: country.names.english,
          searchAliases: country.names.searchAliases,
        },
        politicalStatus: country.politicalStatus,
        moduleVersions: country.moduleVersions,
      },
    }),
  );
}
