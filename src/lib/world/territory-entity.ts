import type {ActiveCountryId} from "./country-id";
import {assertSingleEffectiveControlRepresentation} from "./territory-control-invariant";
import {readTerritoryId, type TerritoryId} from "./territory-id";

export type TerritoryPropertyValue = string | number | boolean | null;
export type TerritoryProperties = Readonly<Record<string, TerritoryPropertyValue>>;
export type TerritoryPosition = readonly [longitude: number, latitude: number];
export type TerritoryLinearRing = readonly TerritoryPosition[];
export type TerritoryPolygonCoordinates = readonly TerritoryLinearRing[];
export type TerritoryGeometry =
  | Readonly<{type: "Polygon"; coordinates: TerritoryPolygonCoordinates}>
  | Readonly<{type: "MultiPolygon"; coordinates: readonly TerritoryPolygonCoordinates[]}>;

export type TerritoryEntity = Readonly<{
  id: TerritoryId;
  ownerCountryId: ActiveCountryId | null;
  geometry: TerritoryGeometry;
  properties: TerritoryProperties;
}>;

const territoryEntityKeys = ["geometry", "id", "ownerCountryId", "properties"] as const;

const countryMetadataKeys = new Set([
  "capital",
  "diplomacy",
  "economy",
  "focusTree",
  "iso3",
  "mapColor",
  "moduleVersions",
  "names",
  "nationalFocus",
  "playable",
  "politicalStatus",
  "presentation",
  "presentationOverride",
  "unitType",
]);

const assertExactKeys = (value: object, expectedKeys: readonly string[], context: string) => {
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${context} contains unknown or missing fields`);
  }
};

const readOwnerCountryId = (value: unknown): ActiveCountryId | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error("TerritoryEntity.ownerCountryId must be a canonical CountryId or null");
  }
  return value as ActiveCountryId;
};

const readPosition = (value: unknown, context: string): TerritoryPosition => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error(`${context} must be a finite [longitude, latitude] position`);
  }
  return Object.freeze([value[0], value[1]]) as TerritoryPosition;
};

const ringSignedArea = (ring: TerritoryLinearRing) =>
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2;

const readLinearRing = (value: unknown, context: string): TerritoryLinearRing => {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error(`${context} linear ring must contain at least four positions`);
  }
  const ring = Object.freeze(
    value.map((position, index) => readPosition(position, `${context}[${index}]`)),
  );
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error(`${context} linear ring must be closed`);
  }
  const distinctVertices = new Set(
    ring.slice(0, -1).map(([longitude, latitude]) => `${longitude}:${latitude}`),
  );
  if (distinctVertices.size < 3 || Math.abs(ringSignedArea(ring)) <= Number.EPSILON) {
    throw new Error(`${context} linear ring must have three distinct vertices and non-zero area`);
  }
  return ring;
};

const readPolygonCoordinates = (
  value: unknown,
  context: string,
): TerritoryPolygonCoordinates => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must contain at least one linear ring`);
  }
  return Object.freeze(value.map((ring, index) => readLinearRing(ring, `${context}[${index}]`)));
};

const readGeometry = (value: unknown): TerritoryGeometry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TerritoryEntity.geometry must be a Polygon or MultiPolygon");
  }
  const geometry = value as {type?: unknown; coordinates?: unknown};
  assertExactKeys(value, ["coordinates", "type"], "TerritoryEntity.geometry");
  if (geometry.type === "Polygon") {
    return Object.freeze({
      type: "Polygon",
      coordinates: readPolygonCoordinates(
        geometry.coordinates,
        "TerritoryEntity.geometry.coordinates",
      ),
    });
  }
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new Error("TerritoryEntity.geometry.coordinates must contain at least one polygon");
    }
    return Object.freeze({
      type: "MultiPolygon",
      coordinates: Object.freeze(
        geometry.coordinates.map((polygon, index) =>
          readPolygonCoordinates(
            polygon,
            `TerritoryEntity.geometry.coordinates[${index}]`,
          ),
        ),
      ),
    });
  }
  throw new Error("TerritoryEntity.geometry must be a Polygon or MultiPolygon");
};

const readProperties = (value: unknown): TerritoryProperties => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TerritoryEntity.properties must be an object record");
  }
  const properties: Record<string, TerritoryPropertyValue> = {};
  for (const [key, propertyValue] of Object.entries(value)) {
    if (countryMetadataKeys.has(key)) {
      throw new Error(`TerritoryEntity.properties must not duplicate country metadata: ${key}`);
    }
    if (
      propertyValue !== null &&
      typeof propertyValue !== "string" &&
      typeof propertyValue !== "number" &&
      typeof propertyValue !== "boolean"
    ) {
      throw new Error(`TerritoryEntity.properties.${key} must be a scalar value or null`);
    }
    if (typeof propertyValue === "number" && !Number.isFinite(propertyValue)) {
      throw new Error(`TerritoryEntity.properties.${key} must be finite`);
    }
    properties[key] = propertyValue;
  }
  return Object.freeze(properties);
};

export function createTerritoryEntity(value: unknown): TerritoryEntity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TerritoryEntity must be an object");
  }
  assertSingleEffectiveControlRepresentation(value);
  assertExactKeys(value, territoryEntityKeys, "TerritoryEntity");
  const input = value as Record<(typeof territoryEntityKeys)[number], unknown>;

  return Object.freeze({
    id: readTerritoryId(input.id, "TerritoryEntity.id"),
    ownerCountryId: readOwnerCountryId(input.ownerCountryId),
    geometry: readGeometry(input.geometry),
    properties: readProperties(input.properties),
  });
}
