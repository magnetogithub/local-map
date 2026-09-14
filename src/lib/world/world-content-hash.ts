import {canonicalSerialize} from "./canonical-serializer";
import {assertSha256Hex, type WorldDomainHashRoots} from "./domain-hash-root";
import {sha256Hex} from "./sha256";

export type WorldContentHashInput = Readonly<{
  schemaVersion: number;
  seedVersion: string;
  policyVersion: string;
  hashRoots: WorldDomainHashRoots;
}>;

const WORLD_CONTENT_HASH_SCHEMA_VERSION = 1 as const;

const readVersion = (value: unknown, context: string) => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError(`${context} must be a non-empty canonical string`);
  }
  return value;
};

/** Hashes domain content and version policy without revision, command, or UI metadata. */
export function worldContentHash(input: WorldContentHashInput): string {
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 0) {
    throw new TypeError("schemaVersion must be a non-negative safe integer");
  }
  const roots = {
    countriesRootHash: input.hashRoots.countriesRootHash,
    presentationRootHash: input.hashRoots.presentationRootHash,
    territoriesRootHash: input.hashRoots.territoriesRootHash,
    topologyRootHash: input.hashRoots.topologyRootHash,
  };
  for (const [field, rootHash] of Object.entries(roots)) {
    assertSha256Hex(rootHash, `worldContentHash ${field}`);
  }

  return sha256Hex(
    canonicalSerialize({
      namespace: "worldContent",
      schemaVersion: WORLD_CONTENT_HASH_SCHEMA_VERSION,
      worldSchemaVersion: input.schemaVersion,
      seedVersion: readVersion(input.seedVersion, "seedVersion"),
      policyVersion: readVersion(input.policyVersion, "policyVersion"),
      hashRoots: roots,
    }),
  );
}
