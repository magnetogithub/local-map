import type {ActiveCountryId} from "../world/country-id";
import type {SeedCountryCapital} from "../world/seed-v1-to-v2";
import type {
  TerritoryGeometry,
  TerritoryLinearRing,
  TerritoryPosition,
} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import type {WorldStateV2} from "../world/world-state-v2";

export type CountryCapitalFeatureProperties = Readonly<{
  countryId: ActiveCountryId;
  territoryId: TerritoryId;
  nameKo: string;
  nameEn: string;
  capitalType: string;
  labelRank: number;
}>;

export type CountryCapitalFeature = Readonly<{
  type: "Feature";
  id: ActiveCountryId;
  properties: CountryCapitalFeatureProperties;
  geometry: Readonly<{
    type: "Point";
    coordinates: readonly [number, number];
  }>;
}>;

export type CountryCapitalProjection = Readonly<{
  revision: number;
  appliedRevision: number;
  featuresByCountryId: ReadonlyMap<ActiveCountryId, CountryCapitalFeature>;
  features: readonly CountryCapitalFeature[];
  omittedCountryIds: readonly ActiveCountryId[];
}>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const pointOnSegment = (
  point: readonly [number, number],
  start: TerritoryPosition,
  end: TerritoryPosition,
) => {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-9) return false;
  const dot = (point[0] - start[0]) * (end[0] - start[0]) +
    (point[1] - start[1]) * (end[1] - start[1]);
  if (dot < 0) return false;
  const lengthSquared = (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2;
  return dot <= lengthSquared;
};

const pointInRing = (
  point: readonly [number, number],
  ring: TerritoryLinearRing,
) => {
  let inside = false;
  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index, index += 1) {
    const current = ring[index];
    const previous = ring[previousIndex];
    if (pointOnSegment(point, previous, current)) return true;
    if (
      current[1] > point[1] !== previous[1] > point[1] &&
      point[0] < ((previous[0] - current[0]) * (point[1] - current[1])) /
        (previous[1] - current[1]) + current[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
};

const pointInPolygon = (
  point: readonly [number, number],
  polygon: readonly TerritoryLinearRing[],
) => pointInRing(point, polygon[0]) && polygon.slice(1).every((ring) => !pointInRing(point, ring));

export function pointInTerritoryGeometry(
  point: readonly [number, number],
  geometry: TerritoryGeometry,
): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInPolygon(point, polygon));
}

const containingOwnedTerritoryId = (
  state: WorldStateV2,
  capital: SeedCountryCapital,
): TerritoryId | null => {
  for (const territoryId of state.territoryOrder) {
    const territory = state.territoriesById[territoryId];
    if (
      territory.ownerCountryId === capital.countryId &&
      pointInTerritoryGeometry(capital.coordinates, territory.geometry)
    ) {
      return territoryId;
    }
  }
  return null;
};

const capitalFeature = (
  capital: SeedCountryCapital,
  territoryId: TerritoryId,
): CountryCapitalFeature => Object.freeze({
  type: "Feature" as const,
  id: capital.countryId,
  properties: Object.freeze({
    countryId: capital.countryId,
    territoryId,
    nameKo: capital.nameKo,
    nameEn: capital.nameEn,
    capitalType: capital.capitalType,
    labelRank: capital.labelRank,
  }),
  geometry: Object.freeze({
    type: "Point" as const,
    coordinates: capital.coordinates,
  }),
});

export function createCountryCapitalProjection(
  state: WorldStateV2,
  countryCapitalsById: Readonly<Record<string, SeedCountryCapital>>,
): CountryCapitalProjection {
  const featuresByCountryId = new Map<ActiveCountryId, CountryCapitalFeature>();
  const omittedCountryIds: ActiveCountryId[] = [];

  for (const countryId of state.countryOrder) {
    const capital = countryCapitalsById[countryId];
    if (!capital) {
      omittedCountryIds.push(countryId);
      continue;
    }
    const territoryId = containingOwnedTerritoryId(state, capital);
    if (territoryId === null) {
      omittedCountryIds.push(countryId);
      continue;
    }
    featuresByCountryId.set(countryId, capitalFeature(capital, territoryId));
  }

  return Object.freeze({
    revision: state.revision,
    appliedRevision: state.revision,
    featuresByCountryId,
    features: Object.freeze([...featuresByCountryId.values()].sort((left, right) =>
      compareText(left.properties.countryId, right.properties.countryId),
    )),
    omittedCountryIds: Object.freeze(omittedCountryIds.sort(compareText)),
  });
}

export function countDanglingCapitalFeatures(
  projection: CountryCapitalProjection,
  state: WorldStateV2,
): number {
  return projection.features.filter((feature) => {
    const territory = state.territoriesById[feature.properties.territoryId];
    return !state.countriesById[feature.properties.countryId] ||
      !territory ||
      territory.ownerCountryId !== feature.properties.countryId ||
      !pointInTerritoryGeometry(feature.geometry.coordinates, territory.geometry);
  }).length;
}
