import {canonicalSerialize, canonicalStringify} from "./canonical-serializer";

export type CanonicalExteriorRingWinding = "counterclockwise" | "clockwise";

export type CanonicalGeometryPolicy = Readonly<{
  coordinatePrecision: number;
  exteriorRingWinding: CanonicalExteriorRingWinding;
}>;

export type CanonicalPosition = readonly [longitude: number, latitude: number];
export type CanonicalLinearRing = readonly CanonicalPosition[];
export type CanonicalPolygonCoordinates = readonly CanonicalLinearRing[];
export type CanonicalGeometry =
  | Readonly<{type: "Polygon"; coordinates: CanonicalPolygonCoordinates}>
  | Readonly<{
      type: "MultiPolygon";
      coordinates: readonly CanonicalPolygonCoordinates[];
    }>;

const geometryKeys = ["coordinates", "type"];
const policyKeys = ["coordinatePrecision", "exteriorRingWinding"];

const compareNumbers = (left: number, right: number) =>
  left < right ? -1 : left > right ? 1 : 0;

const comparePositions = (left: CanonicalPosition, right: CanonicalPosition) =>
  compareNumbers(left[0], right[0]) || compareNumbers(left[1], right[1]);

const compareCanonicalValues = (left: unknown, right: unknown) => {
  const leftKey = canonicalStringify(left);
  const rightKey = canonicalStringify(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

const samePosition = (left: CanonicalPosition, right: CanonicalPosition) =>
  left[0] === right[0] && left[1] === right[1];

const assertExactKeys = (value: object, expected: readonly string[], context: string) => {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${context} contains unknown or missing fields`);
  }
};

function readPolicy(value: CanonicalGeometryPolicy): CanonicalGeometryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Canonical geometry policy must be an object");
  }
  assertExactKeys(value, policyKeys, "Canonical geometry policy");
  if (
    !Number.isInteger(value.coordinatePrecision) ||
    value.coordinatePrecision < 0 ||
    value.coordinatePrecision > 15
  ) {
    throw new RangeError("Canonical geometry policy precision must be an integer from 0 to 15");
  }
  if (
    value.exteriorRingWinding !== "counterclockwise" &&
    value.exteriorRingWinding !== "clockwise"
  ) {
    throw new TypeError("Canonical geometry policy winding is invalid");
  }
  return value;
}

const roundCoordinate = (value: number, precision: number) => {
  const rounded = Number(value.toFixed(precision));
  return Object.is(rounded, -0) ? 0 : rounded;
};

function readPosition(value: unknown, precision: number, context: string): CanonicalPosition {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
  ) {
    throw new TypeError(`${context} must be a finite [longitude, latitude] position`);
  }
  return Object.freeze([
    roundCoordinate(value[0], precision),
    roundCoordinate(value[1], precision),
  ]) as CanonicalPosition;
}

const signedArea = (body: readonly CanonicalPosition[]) =>
  body.reduce((area, position, index) => {
    const next = body[(index + 1) % body.length];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2;

function compareRotations(
  ring: readonly CanonicalPosition[],
  leftStart: number,
  rightStart: number,
) {
  for (let offset = 0; offset < ring.length; offset += 1) {
    const comparison = comparePositions(
      ring[(leftStart + offset) % ring.length],
      ring[(rightStart + offset) % ring.length],
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function rotateToCanonicalStart(body: readonly CanonicalPosition[]): CanonicalPosition[] {
  let start = 0;
  for (let candidate = 1; candidate < body.length; candidate += 1) {
    if (compareRotations(body, candidate, start) < 0) start = candidate;
  }
  return [...body.slice(start), ...body.slice(0, start)];
}

function normalizeRing(
  value: unknown,
  precision: number,
  desiredWinding: CanonicalExteriorRingWinding,
  context: string,
): CanonicalLinearRing {
  if (!Array.isArray(value) || value.length < 4) {
    throw new TypeError(`${context} must contain at least four positions`);
  }
  const rounded = value.map((position, index) =>
    readPosition(position, precision, `${context}[${index}]`),
  );
  if (!samePosition(rounded[0], rounded[rounded.length - 1])) {
    throw new TypeError(`${context} must be closed`);
  }

  const deduplicated: CanonicalPosition[] = [];
  for (const position of rounded.slice(0, -1)) {
    if (!deduplicated.length || !samePosition(position, deduplicated.at(-1)!)) {
      deduplicated.push(position);
    }
  }
  while (
    deduplicated.length > 1 &&
    samePosition(deduplicated[0], deduplicated[deduplicated.length - 1])
  ) {
    deduplicated.pop();
  }

  const distinctPositions = new Set(
    deduplicated.map((position) => canonicalStringify(position)),
  );
  const area = signedArea(deduplicated);
  if (distinctPositions.size < 3 || !Number.isFinite(area) || area === 0) {
    throw new RangeError(`${context} collapses below non-zero polygon area at policy precision`);
  }

  const isCounterclockwise = area > 0;
  const shouldBeCounterclockwise = desiredWinding === "counterclockwise";
  const wound = isCounterclockwise === shouldBeCounterclockwise
    ? deduplicated
    : [...deduplicated].reverse();
  const canonicalBody = rotateToCanonicalStart(wound);
  const closed = [...canonicalBody, canonicalBody[0]];
  return Object.freeze(closed);
}

function normalizePolygon(
  value: unknown,
  policy: CanonicalGeometryPolicy,
  context: string,
): CanonicalPolygonCoordinates {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${context} must contain at least one ring`);
  }
  const holeWinding = policy.exteriorRingWinding === "counterclockwise"
    ? "clockwise"
    : "counterclockwise";
  const exterior = normalizeRing(
    value[0],
    policy.coordinatePrecision,
    policy.exteriorRingWinding,
    `${context}[0]`,
  );
  const holes = value
    .slice(1)
    .map((ring, index) =>
      normalizeRing(
        ring,
        policy.coordinatePrecision,
        holeWinding,
        `${context}[${index + 1}]`,
      ),
    )
    .sort(compareCanonicalValues);
  return Object.freeze([exterior, ...holes]);
}

export function normalizeCanonicalGeometry(
  value: unknown,
  selectedPolicy: CanonicalGeometryPolicy,
): CanonicalGeometry {
  const policy = readPolicy(selectedPolicy);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Canonical geometry must be a Polygon or MultiPolygon object");
  }
  assertExactKeys(value, geometryKeys, "Canonical geometry");
  const geometry = value as {type?: unknown; coordinates?: unknown};

  if (geometry.type === "Polygon") {
    return Object.freeze({
      type: "Polygon",
      coordinates: normalizePolygon(geometry.coordinates, policy, "geometry.coordinates"),
    });
  }
  if (geometry.type === "MultiPolygon") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new TypeError("geometry.coordinates must contain at least one polygon");
    }
    const coordinates = geometry.coordinates
      .map((polygon, index) =>
        normalizePolygon(polygon, policy, `geometry.coordinates[${index}]`),
      )
      .sort(compareCanonicalValues);
    return Object.freeze({type: "MultiPolygon", coordinates: Object.freeze(coordinates)});
  }
  throw new TypeError("Canonical geometry type must be Polygon or MultiPolygon");
}

export function canonicalGeometrySerialize(
  geometry: unknown,
  policy: CanonicalGeometryPolicy,
): Uint8Array {
  return canonicalSerialize(normalizeCanonicalGeometry(geometry, policy));
}
