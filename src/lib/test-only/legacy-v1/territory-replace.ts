import {z} from "zod";

import type {PolygonGeometry, Position} from "@/lib/map/country-label-layout";
import {replaceCountryGeometry, type WorldState} from "./world-state";

import {mapCommandEnvelopeSchema} from "../../commands/map-command";

type LinearRing = Position[];
type PolygonCoordinates = LinearRing[];

const EPSILON = 1e-12;

const positionKey = ([x, y]: Position) => `${x},${y}`;
const coordinatesKey = (value: unknown) => JSON.stringify(value);
const compareCanonicalKeys = (left: unknown, right: unknown) => {
  const leftKey = coordinatesKey(left);
  const rightKey = coordinatesKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};
const compareCoordinates = (left: Position, right: Position) =>
  left[0] - right[0] || left[1] - right[1];
const normalizedNumber = (value: number) => (Object.is(value, -0) ? 0 : value);

const signedArea = (ring: readonly Position[]) =>
  ring.slice(0, -1).reduce((area, point, index) => {
    const next = ring[index + 1];
    return area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;

const cross = (a: Position, b: Position, c: Position) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const pointOnSegment = (point: Position, start: Position, end: Position) =>
  Math.abs(cross(start, end, point)) <= EPSILON &&
  point[0] >= Math.min(start[0], end[0]) - EPSILON &&
  point[0] <= Math.max(start[0], end[0]) + EPSILON &&
  point[1] >= Math.min(start[1], end[1]) - EPSILON &&
  point[1] <= Math.max(start[1], end[1]) + EPSILON;

function segmentsIntersect(a: Position, b: Position, c: Position, d: Position) {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);

  if (
    ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
    ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
  ) {
    return true;
  }

  return (
    (Math.abs(abC) <= EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= EPSILON && pointOnSegment(b, c, d))
  );
}

function assertNoSelfIntersection(ring: LinearRing, context: string) {
  const edgeCount = ring.length - 1;
  for (let first = 0; first < edgeCount; first += 1) {
    for (let second = first + 1; second < edgeCount; second += 1) {
      const adjacent = second === first + 1 || (first === 0 && second === edgeCount - 1);
      if (adjacent) continue;
      if (
        segmentsIntersect(
          ring[first],
          ring[first + 1],
          ring[second],
          ring[second + 1],
        )
      ) {
        throw new Error(`${context} must not self-intersect`);
      }
    }
  }
}

function ringsIntersect(left: LinearRing, right: LinearRing) {
  for (let leftIndex = 0; leftIndex < left.length - 1; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      if (
        segmentsIntersect(
          left[leftIndex],
          left[leftIndex + 1],
          right[rightIndex],
          right[rightIndex + 1],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function pointInRing(point: Position, ring: LinearRing) {
  let inside = false;
  for (let index = 0, previous = ring.length - 2; index < ring.length - 1; previous = index++) {
    const currentPoint = ring[index];
    const previousPoint = ring[previous];
    const crosses =
      currentPoint[1] > point[1] !== previousPoint[1] > point[1] &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) /
          (previousPoint[1] - currentPoint[1]) +
          currentPoint[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

const pointInPolygon = (point: Position, polygon: PolygonCoordinates) =>
  pointInRing(point, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(point, hole));

function readPosition(value: unknown, context: string): Position {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
  ) {
    throw new Error(`${context} must be a finite [longitude, latitude] position`);
  }
  return [normalizedNumber(value[0]), normalizedNumber(value[1])];
}

function normalizeRing(value: unknown, exterior: boolean, context: string): LinearRing {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error(`${context} must contain at least four positions`);
  }

  const ring = value.map((position, index) => readPosition(position, `${context}[${index}]`));
  const first = ring[0];
  const last = ring.at(-1)!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new Error(`${context} must be closed`);
  }

  const body = ring.slice(0, -1);
  if (new Set(body.map(positionKey)).size !== body.length) {
    throw new Error(`${context} must not repeat vertices`);
  }
  assertNoSelfIntersection(ring, context);

  const area = signedArea(ring);
  if (Math.abs(area) <= EPSILON) {
    throw new Error(`${context} must enclose a non-zero area`);
  }

  const requiresReverse = exterior ? area < 0 : area > 0;
  const wound = requiresReverse ? [...body].reverse() : body;
  let startIndex = 0;
  for (let index = 1; index < wound.length; index += 1) {
    if (compareCoordinates(wound[index], wound[startIndex]) < 0) startIndex = index;
  }
  const canonical = [...wound.slice(startIndex), ...wound.slice(0, startIndex)];
  return [...canonical, [...canonical[0]] as Position];
}

function normalizePolygon(value: unknown, context: string): PolygonCoordinates {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must contain at least one linear ring`);
  }

  const exterior = normalizeRing(value[0], true, `${context}[0]`);
  const holes = value
    .slice(1)
    .map((ring, index) => normalizeRing(ring, false, `${context}[${index + 1}]`));

  for (let index = 0; index < holes.length; index += 1) {
    const hole = holes[index];
    if (ringsIntersect(exterior, hole) || !pointInRing(hole[0], exterior)) {
      throw new Error(`${context}[${index + 1}] must be contained by the exterior ring`);
    }
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = holes[otherIndex];
      if (
        ringsIntersect(hole, other) ||
        pointInRing(hole[0], other) ||
        pointInRing(other[0], hole)
      ) {
        throw new Error(`${context} holes must not overlap`);
      }
    }
  }

  return [exterior, ...holes.sort(compareCanonicalKeys)];
}

function assertDisjointPolygons(polygons: PolygonCoordinates[], context: string) {
  for (let first = 0; first < polygons.length; first += 1) {
    for (let second = first + 1; second < polygons.length; second += 1) {
      const left = polygons[first];
      const right = polygons[second];
      if (
        left.some((leftRing) => right.some((rightRing) => ringsIntersect(leftRing, rightRing))) ||
        pointInPolygon(left[0][0], right) ||
        pointInPolygon(right[0][0], left)
      ) {
        throw new Error(`${context} polygons must not overlap`);
      }
    }
  }
}

export function normalizePolygonGeometry(value: unknown): PolygonGeometry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("geometry must be a Polygon or MultiPolygon object");
  }
  const candidate = value as {type?: unknown; coordinates?: unknown};
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 2 || keys[0] !== "coordinates" || keys[1] !== "type") {
    throw new Error("geometry contains unknown or missing fields");
  }

  if (candidate.type === "Polygon") {
    return {type: "Polygon", coordinates: normalizePolygon(candidate.coordinates, "geometry.coordinates")};
  }

  if (candidate.type === "MultiPolygon") {
    if (!Array.isArray(candidate.coordinates) || candidate.coordinates.length === 0) {
      throw new Error("geometry.coordinates must contain at least one polygon");
    }
    const polygons = candidate.coordinates.map((polygon, index) =>
      normalizePolygon(polygon, `geometry.coordinates[${index}]`),
    );
    assertDisjointPolygons(polygons, "geometry.coordinates");
    polygons.sort(compareCanonicalKeys);
    return {type: "MultiPolygon", coordinates: polygons};
  }

  throw new Error("geometry.type must be Polygon or MultiPolygon");
}

export const territoryReplaceGeometrySchema = z.unknown().transform((value, context) => {
  try {
    return normalizePolygonGeometry(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid polygon geometry",
    });
    return z.NEVER;
  }
});

export const territoryReplacePayloadSchema = z.strictObject({
  countryId: z.string().trim().min(1),
  geometry: territoryReplaceGeometrySchema,
});

export const territoryReplaceCommandSchema = mapCommandEnvelopeSchema.extend({
  type: z.literal("territory.replace"),
  payload: territoryReplacePayloadSchema,
});

export type TerritoryReplacePayload = z.infer<typeof territoryReplacePayloadSchema>;
export type TerritoryReplaceCommand = z.infer<typeof territoryReplaceCommandSchema>;

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const territoryReplaceCommandSchemaFor = (
  state: Pick<WorldState, "countriesById">,
) =>
  territoryReplaceCommandSchema.superRefine((command, context) => {
    const countryId = command.payload.countryId;
    if (!hasOwn(state.countriesById, countryId)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "countryId"],
        message: `Country does not exist: ${countryId}`,
      });
    }
  });

export const parseTerritoryReplaceCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
): TerritoryReplaceCommand => territoryReplaceCommandSchemaFor(state).parse(input);

export const safeParseTerritoryReplaceCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
) => territoryReplaceCommandSchemaFor(state).safeParse(input);

export function applyTerritoryReplaceCommand(state: WorldState, input: unknown): WorldState {
  const command = parseTerritoryReplaceCommand(input, state);
  return replaceCountryGeometry(state, command.payload.countryId, command.payload.geometry);
}
