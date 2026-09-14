import {canonicalSerialize} from "./canonical-serializer";
import type {CountryEntity} from "./country-entity";
import type {CountryPresentationOverride} from "./country-presentation-override";
import {sha256Hex} from "./sha256";

const COUNTRY_PRESENTATION_HASH_SCHEMA_VERSION = 1 as const;

function serializeOverride(override: CountryPresentationOverride | null) {
  if (override === null) return null;

  const serialized: {
    center?: readonly [number, number];
    defaultZoom?: number;
    labelAnchor?: readonly [number, number];
    labelScale?: number;
    policyVersion: string;
    reason: string;
  } = {
    policyVersion: override.policyVersion,
    reason: override.reason,
  };
  if (override.center !== undefined) serialized.center = override.center;
  if (override.defaultZoom !== undefined) serialized.defaultZoom = override.defaultZoom;
  if (override.labelAnchor !== undefined) serialized.labelAnchor = override.labelAnchor;
  if (override.labelScale !== undefined) serialized.labelScale = override.labelScale;
  return serialized;
}

/**
 * Hashes automatic presentation policy and its reviewed override only.
 * Country identity, names, and Territory ownership are deliberately external to this leaf.
 */
export function countryPresentationLeafHash(
  country: Pick<CountryEntity, "presentationOverride">,
  automaticPolicyVersion: string,
): string {
  if (
    typeof automaticPolicyVersion !== "string" ||
    automaticPolicyVersion.length === 0 ||
    automaticPolicyVersion !== automaticPolicyVersion.trim()
  ) {
    throw new TypeError("Automatic presentation policy version must be a canonical string");
  }

  return sha256Hex(
    canonicalSerialize({
      namespace: "countryPresentation",
      schemaVersion: COUNTRY_PRESENTATION_HASH_SCHEMA_VERSION,
      automaticPolicyVersion,
      override: serializeOverride(country.presentationOverride),
    }),
  );
}
