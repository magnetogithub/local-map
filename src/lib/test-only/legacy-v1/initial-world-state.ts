// Legacy V1 seed fixture only; production bootstraps WorldStateV2.
import type {Country} from "@/types/country";
import {
  createWorldState,
  type CapitalFeature,
  type CountryGeometryFeature,
  type WorldState,
} from "./world-state";

export type SeedFeatureCollection<TFeature> = {
  type: "FeatureCollection";
  features: readonly TFeature[];
};

export type InitialWorldStateSeed = {
  metadata: readonly Country[];
  countryGeometry: SeedFeatureCollection<CountryGeometryFeature>;
  capitals: SeedFeatureCollection<CapitalFeature>;
};

const assertFeatureCollection = (
  value: {type?: unknown; features?: unknown},
  name: string,
) => {
  if (value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error(`${name} must be a GeoJSON FeatureCollection`);
  }
};

const assertUniqueFeatureIds = (
  features: readonly {properties: {countryId: string}}[],
  name: string,
) => {
  const ids = new Set<string>();
  for (const feature of features) {
    const id = feature.properties.countryId;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error(`${name} contains an empty country id`);
    }
    if (ids.has(id)) {
      throw new Error(`${name} contains a duplicate country id: ${id}`);
    }
    ids.add(id);
  }
};

export function createInitialWorldState(seed: InitialWorldStateSeed): WorldState {
  assertFeatureCollection(seed.countryGeometry, "Country geometry seed");
  assertFeatureCollection(seed.capitals, "Capital seed");
  assertUniqueFeatureIds(seed.countryGeometry.features, "Country geometry seed");
  assertUniqueFeatureIds(seed.capitals.features, "Capital seed");

  const metadataIds = new Set(seed.metadata.map((country) => country.id));
  const extraCapitalIds = seed.capitals.features
    .map((feature) => feature.properties.countryId)
    .filter((id) => !metadataIds.has(id));
  if (extraCapitalIds.length > 0) {
    throw new Error(`Capital without country metadata: ${extraCapitalIds.join(",")}`);
  }

  return createWorldState(
    seed.metadata,
    seed.countryGeometry.features,
    seed.capitals.features,
  );
}

export {createWorldState};
