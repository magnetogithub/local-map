import type {Country} from "@/types/country";
import {
  computeCountryGeometryHash,
  type CountryLabelLayoutInput,
  type PolygonGeometry,
  type Position,
} from "@/lib/map/country-label-layout";
import type {CountryNames} from "../../world/country-names";

export type {CountryNames} from "../../world/country-names";

export const WORLD_STATE_SCHEMA_VERSION = 1 as const;

export type CountryCapital = {
  nameKo: string;
  nameEn: string;
  coordinates: [number, number] | null;
};

export type CountryEntity = {
  id: string;
  iso3: string;
  names: CountryNames;
  geometry: PolygonGeometry;
  mapColor: string;
  playable: boolean;
  unitType: Country["unitType"];
  capital: CountryCapital | null;
  presentation: {
    flagCode: string;
    region: string;
    center: [number, number];
    defaultZoom: number;
    labelRank: number;
  };
};

export type WorldState = {
  schemaVersion: typeof WORLD_STATE_SCHEMA_VERSION;
  revision: number;
  countriesById: Record<string, CountryEntity>;
  countryOrder: string[];
};

export type CountryReplacement = {
  removeCountryIds: string[];
  upsertCountries: CountryEntity[];
};

export type WorldStateRollback = {
  before: WorldState;
  appliedRevision: number;
};

export type CountryGeometryFeature = {
  type: "Feature";
  properties: {countryId: string};
  geometry: PolygonGeometry;
};

export type CapitalFeature = {
  type: "Feature";
  properties: {countryId: string; nameKo?: string; nameEn?: string};
  geometry: {type: "Point"; coordinates: [number, number]};
};

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

function assertCountryId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty country id`);
  }
}

function assertPosition(value: unknown, context: string): asserts value is Position {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error(`${context} must be a finite [longitude, latitude] position`);
  }
}

const ringSignedArea = (ring: readonly Position[]) =>
  ring.slice(0, -1).reduce((area, point, index) => {
    const next = ring[index + 1];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;

function assertLinearRing(value: unknown, context: string): asserts value is Position[] {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error(`${context} must contain at least four positions`);
  }

  value.forEach((position, index) => assertPosition(position, `${context}[${index}]`));
  const ring = value as Position[];
  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error(`${context} must be closed`);
  }

  const distinctVertices = new Set(
    ring.slice(0, -1).map(([longitude, latitude]) => `${longitude}:${latitude}`),
  );
  if (distinctVertices.size < 3 || Math.abs(ringSignedArea(ring)) <= Number.EPSILON) {
    throw new Error(`${context} must enclose a non-zero area`);
  }
}

const assertPolygonCoordinates = (value: unknown, context: string) => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must contain at least one linear ring`);
  }
  value.forEach((ring, index) => assertLinearRing(ring, `${context}[${index}]`));
};

export function assertPolygonGeometry(
  value: unknown,
  context = "geometry",
): asserts value is PolygonGeometry {
  if (!value || typeof value !== "object") {
    throw new Error(`${context} must be a Polygon or MultiPolygon`);
  }

  const candidate = value as {type?: unknown; coordinates?: unknown};
  if (candidate.type === "Polygon") {
    assertPolygonCoordinates(candidate.coordinates, `${context}.coordinates`);
    return;
  }

  if (candidate.type === "MultiPolygon") {
    if (!Array.isArray(candidate.coordinates) || candidate.coordinates.length === 0) {
      throw new Error(`${context}.coordinates must contain at least one polygon`);
    }
    candidate.coordinates.forEach((polygon, index) =>
      assertPolygonCoordinates(polygon, `${context}.coordinates[${index}]`),
    );
    return;
  }

  throw new Error(`${context}.type must be Polygon or MultiPolygon`);
}

export function assertWorldState(value: unknown): asserts value is WorldState {
  if (!value || typeof value !== "object") {
    throw new Error("WorldState must be an object");
  }

  const state = value as Partial<WorldState>;
  if (state.schemaVersion !== WORLD_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported WorldState schema version: ${String(state.schemaVersion)}`);
  }
  if (!Number.isSafeInteger(state.revision) || (state.revision ?? -1) < 0) {
    throw new Error("WorldState revision must be a non-negative safe integer");
  }
  if (!state.countriesById || typeof state.countriesById !== "object" || Array.isArray(state.countriesById)) {
    throw new Error("WorldState countriesById must be an object record");
  }
  if (!Array.isArray(state.countryOrder)) {
    throw new Error("WorldState countryOrder must be an array");
  }

  const orderedIds = new Set<string>();
  state.countryOrder.forEach((id, index) => {
    assertCountryId(id, `WorldState countryOrder[${index}]`);
    if (orderedIds.has(id)) {
      throw new Error(`Duplicate country id in countryOrder: ${id}`);
    }
    orderedIds.add(id);
  });

  const countryIds = Object.keys(state.countriesById);
  if (countryIds.length !== orderedIds.size) {
    throw new Error("WorldState countriesById and countryOrder must contain the same ids");
  }

  for (const id of countryIds) {
    assertCountryId(id, "WorldState countriesById key");
    if (!orderedIds.has(id)) {
      throw new Error(`Country id is missing from countryOrder: ${id}`);
    }

    const entity = state.countriesById[id];
    if (!entity || typeof entity !== "object") {
      throw new Error(`Country entity must be an object: ${id}`);
    }
    assertCountryId(entity.id, `Country entity id for key ${id}`);
    if (entity.id !== id) {
      throw new Error(`Country entity id does not match its key: ${entity.id} !== ${id}`);
    }
    assertPolygonGeometry(entity.geometry, `Country ${id} geometry`);
  }

  for (const id of orderedIds) {
    if (!hasOwn(state.countriesById, id)) {
      throw new Error(`countryOrder references an unknown country id: ${id}`);
    }
  }
}

const aliases = (country: Country) =>
  [country.id, country.iso3, country.nameKo, country.mapLabelKo, country.nameEn].filter(
    (value, index, all) => value && all.indexOf(value) === index,
  );

export function createWorldState(
  metadata: readonly Country[],
  geometryFeatures: readonly CountryGeometryFeature[],
  capitalFeatures: readonly CapitalFeature[] = [],
): WorldState {
  const geometryById = new Map(
    geometryFeatures.map((feature) => [feature.properties.countryId, feature.geometry]),
  );
  const capitalById = new Map(
    capitalFeatures.map((feature) => [feature.properties.countryId, feature]),
  );
  const countriesById: Record<string, CountryEntity> = Object.create(null);
  const countryOrder: string[] = [];

  for (const country of metadata) {
    assertCountryId(country.id, "Country metadata id");
    if (hasOwn(countriesById, country.id)) {
      throw new Error(`Duplicate country id: ${country.id}`);
    }
    const geometry = geometryById.get(country.id);
    if (!geometry) {
      throw new Error(`Missing geometry for country: ${country.id}`);
    }
    const capital = capitalById.get(country.id);
    const hasCapital = country.capitalKo !== "—" || country.capitalEn !== "—";
    countriesById[country.id] = {
      id: country.id,
      iso3: country.iso3,
      names: {
        shortKo: country.nameKo,
        officialKo: country.nameKo,
        mapKo: country.mapLabelKo,
        english: country.nameEn,
        searchAliases: aliases(country),
      },
      geometry,
      mapColor: country.mapColor,
      playable: country.playable,
      unitType: country.unitType,
      capital: hasCapital
        ? {
            nameKo: country.capitalKo,
            nameEn: country.capitalEn,
            coordinates: capital?.geometry.coordinates ?? null,
          }
        : null,
      presentation: {
        flagCode: country.flagCode,
        region: country.region,
        center: country.center,
        defaultZoom: country.defaultZoom,
        labelRank: country.labelRank,
      },
    };
    countryOrder.push(country.id);
  }

  const extraGeometry = geometryFeatures
    .map((feature) => feature.properties.countryId)
    .filter((id) => !hasOwn(countriesById, id));
  if (extraGeometry.length) {
    throw new Error(`Geometry without country metadata: ${extraGeometry.join(",")}`);
  }

  const state: WorldState = {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    revision: 0,
    countriesById,
    countryOrder,
  };
  assertWorldState(state);
  return state;
}

export function countryEntityToLabelInput(
  country: CountryEntity,
  previousLayout?: CountryLabelLayoutInput["previousLayout"],
): CountryLabelLayoutInput {
  return {countryId: country.id, geometry: country.geometry, label: country.names.mapKo, previousLayout};
}

export function replaceCountryNames(
  state: WorldState,
  countryId: string,
  names: CountryNames,
): WorldState {
  const country = state.countriesById[countryId];
  if (!country) throw new Error(`Unknown country: ${countryId}`);
  return {
    ...state,
    revision: state.revision + 1,
    countriesById: {...state.countriesById, [countryId]: {...country, names}},
  };
}

export function replaceCountryGeometry(
  state: WorldState,
  countryId: string,
  geometry: PolygonGeometry,
): WorldState {
  const country = state.countriesById[countryId];
  if (!country) throw new Error(`Unknown country: ${countryId}`);
  assertPolygonGeometry(geometry, `Country ${countryId} geometry`);
  return {
    ...state,
    revision: state.revision + 1,
    countriesById: {...state.countriesById, [countryId]: {...country, geometry}},
  };
}

export function applyCountryReplacement(
  state: WorldState,
  replacement: CountryReplacement,
): {state: WorldState; rollback: WorldStateRollback} {
  const removeIds = new Set(replacement.removeCountryIds);
  if (removeIds.size !== replacement.removeCountryIds.length) {
    throw new Error("Duplicate country removal id");
  }
  for (const id of removeIds) {
    if (!state.countriesById[id]) throw new Error(`Unknown country removal: ${id}`);
  }

  const upsertIds = new Set<string>();
  for (const country of replacement.upsertCountries) {
    assertCountryId(country.id, "Country upsert id");
    if (upsertIds.has(country.id)) {
      throw new Error(`Duplicate country upsert id: ${country.id}`);
    }
    if (state.countriesById[country.id] && !removeIds.has(country.id)) {
      throw new Error(`Country upsert would overwrite an unrelated country: ${country.id}`);
    }
    assertPolygonGeometry(country.geometry, `Country ${country.id} geometry`);
    upsertIds.add(country.id);
  }

  const countriesById = {...state.countriesById};
  for (const id of removeIds) delete countriesById[id];
  for (const country of replacement.upsertCountries) countriesById[country.id] = country;
  const countryOrder = state.countryOrder.filter((id) => !removeIds.has(id));
  for (const country of replacement.upsertCountries) {
    if (!countryOrder.includes(country.id)) countryOrder.push(country.id);
  }

  const next: WorldState = {
    ...state,
    revision: state.revision + 1,
    countriesById,
    countryOrder,
  };
  return {state: next, rollback: {before: state, appliedRevision: next.revision}};
}

export function rollbackCountryReplacement(
  current: WorldState,
  rollback: WorldStateRollback,
): WorldState {
  if (current.revision !== rollback.appliedRevision) {
    throw new Error(
      `WorldState changed after replacement: ${current.revision} !== ${rollback.appliedRevision}`,
    );
  }
  return rollback.before;
}

export function countryEntityGeometryHash(country: CountryEntity) {
  return computeCountryGeometryHash(country.geometry);
}

export function countryEntityLabelCacheKey(country: CountryEntity) {
  return `${countryEntityGeometryHash(country)}:${country.names.mapKo}`;
}

export function countryEntityToCountry(country: CountryEntity): Country {
  return {
    id: country.id,
    iso3: country.iso3,
    nameKo: country.names.shortKo,
    nameEn: country.names.english,
    mapLabelKo: country.names.mapKo,
    capitalKo: country.capital?.nameKo ?? "—",
    capitalEn: country.capital?.nameEn ?? "—",
    flagCode: country.presentation.flagCode,
    region: country.presentation.region,
    mapColor: country.mapColor,
    center: country.presentation.center,
    defaultZoom: country.presentation.defaultZoom,
    unitType: country.unitType,
    playable: country.playable,
    labelRank: country.presentation.labelRank,
  };
}
