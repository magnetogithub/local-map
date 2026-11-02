import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";

export const DOMAIN_HASH_NAMES = [
  "countries",
  "presentation",
  "territories",
  "topology",
] as const;

export type DomainHashName = (typeof DOMAIN_HASH_NAMES)[number];
export type LeafHashRecord = Readonly<Record<string, string>>;

export type WorldLeafHashRecords = Readonly<{
  countryCoreHashes: LeafHashRecord;
  countryPresentationHashes: LeafHashRecord;
  territoryGeometryHashes: LeafHashRecord;
  territoryOwnershipHashes: LeafHashRecord;
  topologyEdgeHashes: LeafHashRecord;
}>;

export type WorldDomainHashRoots = Readonly<{
  countriesRootHash: string;
  presentationRootHash: string;
  territoriesRootHash: string;
  topologyRootHash: string;
}>;

const DOMAIN_ROOT_HASH_SCHEMA_VERSION = 1 as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export function assertSha256Hex(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${context} must be a lowercase SHA-256 leaf hash`);
  }
}

export function buildDomainRootHash(
  domain: DomainHashName,
  leafHashes: LeafHashRecord,
): string {
  if (!DOMAIN_HASH_NAMES.includes(domain)) {
    throw new TypeError(`Unknown domain hash namespace: ${domain}`);
  }
  const leaves = Object.entries(leafHashes)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, leafHash]) => {
      if (key.length === 0 || key !== key.trim()) {
        throw new TypeError("Domain leaf key must be a non-empty canonical string");
      }
      assertSha256Hex(leafHash, `Domain leaf hash ${key}`);
      return [key, leafHash] as const;
    });

  return sha256Hex(
    canonicalSerialize({
      namespace: "domainRoot",
      schemaVersion: DOMAIN_ROOT_HASH_SCHEMA_VERSION,
      domain,
      leaves,
    }),
  );
}

const prefixLeafKeys = (prefix: string, leafHashes: LeafHashRecord) =>
  Object.fromEntries(Object.entries(leafHashes).map(([key, value]) => [`${prefix}:${key}`, value]));

export function buildWorldDomainHashRoots(
  leafHashes: WorldLeafHashRecords,
): WorldDomainHashRoots {
  return Object.freeze({
    countriesRootHash: buildDomainRootHash("countries", leafHashes.countryCoreHashes),
    presentationRootHash: buildDomainRootHash(
      "presentation",
      leafHashes.countryPresentationHashes,
    ),
    territoriesRootHash: buildDomainRootHash("territories", {
      ...prefixLeafKeys("geometry", leafHashes.territoryGeometryHashes),
      ...prefixLeafKeys("ownership", leafHashes.territoryOwnershipHashes),
    }),
    topologyRootHash: buildDomainRootHash("topology", leafHashes.topologyEdgeHashes),
  });
}
