import type {TerritoryEntity, TerritoryGeometry, TerritoryPosition} from "./territory-entity";
import type {TerritoryId} from "./territory-id";

export type TerritoryBBox = Readonly<{
  minLongitude: number;
  minLatitude: number;
  maxLongitude: number;
  maxLatitude: number;
}>;

export type TerritoryBBoxIndex = Readonly<{
  bboxByTerritoryId: Readonly<Record<string, TerritoryBBox>>;
}>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const normalizeLongitude = (longitude: number) => {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
};

function positionsOf(geometry: TerritoryGeometry): TerritoryPosition[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((polygon) => polygon.flatMap((ring) => [...ring]));
}

export function calculateTerritoryBBox(geometry: TerritoryGeometry): TerritoryBBox {
  const positions = positionsOf(geometry);
  if (positions.length === 0) throw new TypeError("Territory geometry contains no positions");
  const longitudes = positions.map(([longitude]) => normalizeLongitude(longitude)).sort((a, b) => a - b);
  let largestGap = -1;
  let startIndex = 0;
  for (let index = 0; index < longitudes.length; index += 1) {
    const current = longitudes[index];
    const next = index + 1 < longitudes.length ? longitudes[index + 1] : longitudes[0] + 360;
    if (next - current > largestGap) {
      largestGap = next - current;
      startIndex = (index + 1) % longitudes.length;
    }
  }
  const start = longitudes[startIndex];
  const unwrapped = longitudes.map((longitude) => longitude < start ? longitude + 360 : longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return Object.freeze({
    minLongitude: Math.min(...unwrapped),
    minLatitude: Math.min(...latitudes),
    maxLongitude: Math.max(...unwrapped),
    maxLatitude: Math.max(...latitudes),
  });
}

export function territoryBBoxesIntersect(left: TerritoryBBox, right: TerritoryBBox): boolean {
  if (left.maxLatitude < right.minLatitude || right.maxLatitude < left.minLatitude) return false;
  return [-360, 0, 360].some((shift) =>
    left.minLongitude <= right.maxLongitude + shift &&
    right.minLongitude + shift <= left.maxLongitude
  );
}

export function createTerritoryBBoxIndex(
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
): TerritoryBBoxIndex {
  const bboxByTerritoryId: Record<string, TerritoryBBox> = {};
  for (const territoryId of Object.keys(territoriesById).sort(compareText)) {
    bboxByTerritoryId[territoryId] = calculateTerritoryBBox(territoriesById[territoryId].geometry);
  }
  return Object.freeze({bboxByTerritoryId: Object.freeze(bboxByTerritoryId)});
}

export function updateTerritoryBBoxIndex(
  current: TerritoryBBoxIndex,
  territoriesById: Readonly<Record<string, TerritoryEntity>>,
  changedTerritoryIds: Iterable<TerritoryId>,
): TerritoryBBoxIndex {
  const next: Record<string, TerritoryBBox> = {...current.bboxByTerritoryId};
  for (const territoryId of [...new Set(changedTerritoryIds)].sort(compareText)) {
    const territory = territoriesById[territoryId];
    if (territory) next[territoryId] = calculateTerritoryBBox(territory.geometry);
    else delete next[territoryId];
  }
  return Object.freeze({bboxByTerritoryId: Object.freeze(next)});
}

export function queryTerritoryBBoxCandidates(
  index: TerritoryBBoxIndex,
  territoryId: TerritoryId,
): readonly TerritoryId[] {
  const target = index.bboxByTerritoryId[territoryId];
  if (!target) return Object.freeze([]);
  return Object.freeze(Object.entries(index.bboxByTerritoryId)
    .filter(([candidateId, bbox]) => candidateId !== territoryId && territoryBBoxesIntersect(target, bbox))
    .map(([candidateId]) => candidateId as TerritoryId)
    .sort(compareText));
}
