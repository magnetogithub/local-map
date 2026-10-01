import type {ActiveCountryId} from "../world/country-id";
import type {WorldStateV2} from "../world/world-state-v2";
import type {CountryCapitalFeature, CountryCapitalProjection} from "./country-capital-projection";

export type GeoJsonPoint = Readonly<{
  type: "Point";
  coordinates: readonly [number, number];
}>;

export type GeoJsonFeatureCollection<Feature> = Readonly<{
  type: "FeatureCollection";
  features: readonly Feature[];
}>;

export type SmallCountryMarkerSeed = Readonly<{
  countryId: ActiveCountryId;
  nameKo: string;
  playable: boolean;
  coordinates: readonly [number, number];
}>;

export type SmallCountryMarkerFeature = Readonly<{
  type: "Feature";
  id: ActiveCountryId;
  properties: Readonly<{
    countryId: ActiveCountryId;
    nameKo: string;
    playable: boolean;
    projectionRevision: number;
  }>;
  geometry: GeoJsonPoint;
}>;

export type CountryMapMarkerProjection = Readonly<{
  appliedRevision: number;
  capitals: GeoJsonFeatureCollection<CountryCapitalFeature>;
  smallCountryMarkers: GeoJsonFeatureCollection<SmallCountryMarkerFeature>;
  omittedCapitalCountryIds: readonly ActiveCountryId[];
}>;

export type SerializedCountryMapMarkerProjection = CountryMapMarkerProjection;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const activeCountryId = (countryId: string) => countryId as ActiveCountryId;

export const emptyFeatureCollection = Object.freeze({
  type: "FeatureCollection" as const,
  features: Object.freeze([]),
});

export function shouldApplyCountryMapMarkerProjection(
  currentRevision: number,
  next: CountryMapMarkerProjection,
): boolean {
  return next.appliedRevision > currentRevision;
}

export function createSmallCountryMarkerSeeds(
  collection: Readonly<{
    features: readonly Readonly<{
      properties: Readonly<{
        countryId: string;
        nameKo: string;
        playable: boolean;
      }>;
      geometry: Readonly<{
        type: "Point";
        coordinates: readonly [number, number];
      }>;
    }>[];
  }>,
): Readonly<Record<string, SmallCountryMarkerSeed>> {
  return Object.freeze(Object.fromEntries(collection.features.map((feature) => [
    feature.properties.countryId,
    Object.freeze({
      countryId: activeCountryId(feature.properties.countryId),
      nameKo: feature.properties.nameKo,
      playable: feature.properties.playable,
      coordinates: Object.freeze([...feature.geometry.coordinates] as [number, number]),
    }),
  ])));
}

const smallCountryMarkerFeature = (
  seed: SmallCountryMarkerSeed,
  nameKo: string,
  playable: boolean,
  revision: number,
): SmallCountryMarkerFeature => Object.freeze({
  type: "Feature" as const,
  id: seed.countryId,
  properties: Object.freeze({
    countryId: seed.countryId,
    nameKo,
    playable,
    projectionRevision: revision,
  }),
  geometry: Object.freeze({
    type: "Point" as const,
    coordinates: seed.coordinates,
  }),
});

export function createCountryMapMarkerProjection(
  state: WorldStateV2,
  capitalProjection: CountryCapitalProjection,
  smallCountryMarkersById: Readonly<Record<string, SmallCountryMarkerSeed>>,
): CountryMapMarkerProjection {
  if (capitalProjection.appliedRevision !== state.revision) {
    throw new Error(
      `Country marker capital projection revision ${capitalProjection.appliedRevision} does not match state revision ${state.revision}`,
    );
  }

  const smallCountryMarkers = state.countryOrder
    .map((countryId) => smallCountryMarkersById[countryId])
    .filter((seed): seed is SmallCountryMarkerSeed => seed !== undefined)
    .map((seed) => {
      const country = state.countriesById[seed.countryId];
      return smallCountryMarkerFeature(
        seed,
        country.names.mapKo,
        country.politicalStatus === "sovereign",
        state.revision,
      );
    })
    .sort((left, right) => compareText(left.properties.countryId, right.properties.countryId));

  return Object.freeze({
    appliedRevision: state.revision,
    capitals: Object.freeze({
      type: "FeatureCollection" as const,
      features: capitalProjection.features,
    }),
    smallCountryMarkers: Object.freeze({
      type: "FeatureCollection" as const,
      features: Object.freeze(smallCountryMarkers),
    }),
    omittedCapitalCountryIds: capitalProjection.omittedCountryIds,
  });
}

export function serializeCountryMapMarkerProjection(
  projection: CountryMapMarkerProjection,
): SerializedCountryMapMarkerProjection {
  return projection;
}

export function deserializeCountryMapMarkerProjection(
  projection: SerializedCountryMapMarkerProjection,
): CountryMapMarkerProjection {
  return projection;
}
