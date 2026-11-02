import type {Feature, FeatureCollection, GeoJSON, Geometry} from "geojson";
import type {GeoJSONSourceDiff} from "maplibre-gl";
import {canonicalStringify} from "../world/canonical-serializer";
import type {WorldMapRuntimeProjection} from "../projection/world-map-runtime-projection";
import {MAP_SOURCE_IDS} from "./map-config";

export const RUNTIME_MAP_SOURCE_IDS = [
  MAP_SOURCE_IDS.countriesLow,
  MAP_SOURCE_IDS.bordersLow,
  MAP_SOURCE_IDS.countriesHigh,
  MAP_SOURCE_IDS.bordersHigh,
] as const;

export type RuntimeMapSourceId = (typeof RUNTIME_MAP_SOURCE_IDS)[number];
export type IdFeature = Feature<Geometry, Record<string, unknown>> & {id: string};
export type IdFeatureCollection = Omit<FeatureCollection<Geometry, Record<string, unknown>>, "features"> & {
  features: IdFeature[];
};

export type IncrementalGeoJSONSource = {
  setData(data: IdFeatureCollection): unknown;
  updateData(diff: GeoJSONSourceDiff): unknown;
  getData?(): Promise<GeoJSON>;
};

export type MapSourceSyncSnapshot = Readonly<{
  revision: number;
  resyncRequired: boolean;
  error: string | null;
  sources: Readonly<Partial<Record<RuntimeMapSourceId, Readonly<{
    revision: number;
    mode: "initial" | "diff" | "unchanged" | "resync";
    changedIds: readonly string[];
  }>>>>;
}>;

export class MapSourceSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MapSourceSyncError";
  }
}

const collectionOf = (projection: WorldMapRuntimeProjection, id: RuntimeMapSourceId): IdFeatureCollection => {
  const field = id === MAP_SOURCE_IDS.countriesLow ? "countriesLow"
    : id === MAP_SOURCE_IDS.countriesHigh ? "countriesHigh"
    : id === MAP_SOURCE_IDS.bordersLow ? "bordersLow" : "bordersHigh";
  return projection[field] as IdFeatureCollection;
};

const normalizedRing = (ring: number[][]): number[][] => {
  const closed = ring.length > 1 && canonicalStringify(ring[0]) === canonicalStringify(ring[ring.length - 1]);
  const points = closed ? ring.slice(0, -1) : ring;
  if (!points.length) return ring;
  const normalizedDirection = (items: number[][]) => {
    let first = 0;
    for (let index = 1; index < items.length; index++) {
      if (items[index][0] < items[first][0] ||
          (items[index][0] === items[first][0] && items[index][1] < items[first][1])) first = index;
    }
    const rotated = [...items.slice(first), ...items.slice(0, first)];
    return closed ? [...rotated, rotated[0]] : rotated;
  };
  const forward = normalizedDirection(points);
  const backward = normalizedDirection([...points].reverse());
  return canonicalStringify(forward) < canonicalStringify(backward) ? forward : backward;
};

const geometrySignature = (geometry: Geometry): string => {
  if (geometry.type === "Polygon") {
    return canonicalStringify({type: geometry.type, coordinates: geometry.coordinates.map(ring => normalizedRing(ring as number[][]))});
  }
  if (geometry.type === "MultiPolygon") {
    return canonicalStringify({type: geometry.type, coordinates: geometry.coordinates.map(polygon => polygon.map(ring => normalizedRing(ring as number[][])))});
  }
  return canonicalStringify(geometry);
};

export function assertUniqueMapSourceIds(collection: IdFeatureCollection, sourceId: string): void {
  const seen = new Set<string>();
  for (const feature of collection.features) {
    if (typeof feature.id !== "string" || !feature.id || seen.has(feature.id)) {
      throw new MapSourceSyncError(`Invalid or duplicate feature ID in ${sourceId}: ${String(feature.id)}`);
    }
    seen.add(feature.id);
  }
}

export function diffMapSourceFeatures(
  previous: IdFeatureCollection,
  next: IdFeatureCollection,
  sourceId: string,
): Readonly<{diff: GeoJSONSourceDiff; changedIds: readonly string[]}> {
  assertUniqueMapSourceIds(previous, sourceId);
  assertUniqueMapSourceIds(next, sourceId);
  const oldById = new Map(previous.features.map((feature) => [feature.id, feature]));
  const newById = new Map(next.features.map((feature) => [feature.id, feature]));
  const remove = previous.features.filter((feature) => !newById.has(feature.id)).map((feature) => feature.id);
  const add = next.features.filter((feature) => !oldById.has(feature.id));
  const update: NonNullable<GeoJSONSourceDiff["update"]> = [];
  for (const feature of next.features) {
    const old = oldById.get(feature.id);
    if (!old || old === feature) continue;
    const geometryChanged = old.geometry !== feature.geometry &&
      canonicalStringify(old.geometry) !== canonicalStringify(feature.geometry);
    const propertiesChanged = old.properties !== feature.properties &&
      canonicalStringify(old.properties) !== canonicalStringify(feature.properties);
    if (!geometryChanged && !propertiesChanged) continue;
    update.push({
      id: feature.id,
      ...(geometryChanged ? {newGeometry: feature.geometry} : {}),
      ...(propertiesChanged ? {
        removeAllProperties: true,
        addOrUpdateProperties: Object.entries(feature.properties).map(([key, value]) => ({key, value})),
      } : {}),
    });
  }
  const diff: GeoJSONSourceDiff = {};
  if (remove.length) diff.remove = remove;
  if (add.length) diff.add = add;
  if (update.length) diff.update = update;
  return {diff, changedIds: [...remove, ...add.map((feature) => feature.id), ...update.map((feature) => String(feature.id))]};
}

type SourceRecord = {
  source: IncrementalGeoJSONSource;
  projection: WorldMapRuntimeProjection;
  mode: "initial" | "diff" | "unchanged" | "resync";
  changedIds: readonly string[];
};

export class MapSourceIncrementalController {
  private records = new Map<RuntimeMapSourceId, SourceRecord>();
  private revision = -1;
  private error: string | null = null;
  private resyncRequired = false;

  snapshot(): MapSourceSyncSnapshot {
    const sources: Partial<Record<RuntimeMapSourceId, {revision: number; mode: SourceRecord["mode"]; changedIds: readonly string[]}>> = {};
    for (const [id, record] of this.records) {
      sources[id] = {revision: record.projection.appliedRevision, mode: record.mode, changedIds: record.changedIds};
    }
    return {revision: this.revision, resyncRequired: this.resyncRequired, error: this.error, sources};
  }

  fail(error: unknown): void {
    this.resyncRequired = true;
    this.error = error instanceof Error ? error.message : String(error);
  }

  synchronize(
    next: WorldMapRuntimeProjection,
    getSource: (id: RuntimeMapSourceId) => IncrementalGeoJSONSource | undefined,
  ): boolean {
    if (this.resyncRequired) throw new MapSourceSyncError(`Map source resynchronization required: ${this.error}`);
    if (next.appliedRevision < this.revision) return false;
    try {
      let didApply = next.appliedRevision > this.revision;
      for (const id of RUNTIME_MAP_SOURCE_IDS) {
        const source = getSource(id);
        if (!source) {
          this.records.delete(id);
          if (id === MAP_SOURCE_IDS.countriesLow || id === MAP_SOURCE_IDS.bordersLow) {
            throw new MapSourceSyncError(`Required map source is missing: ${id}`);
          }
          continue;
        }
        const nextData = collectionOf(next, id);
        assertUniqueMapSourceIds(nextData, id);
        const previous = this.records.get(id);
        if (!previous || previous.source !== source) {
          source.setData(nextData);
          this.records.set(id, {source, projection: next, mode: "initial", changedIds: nextData.features.map((feature) => feature.id)});
          didApply = true;
          continue;
        }
        if (next.appliedRevision <= previous.projection.appliedRevision) continue;
        const {diff, changedIds} = diffMapSourceFeatures(collectionOf(previous.projection, id), nextData, id);
        if (changedIds.length) source.updateData(diff);
        this.records.set(id, {source, projection: next, mode: changedIds.length ? "diff" : "unchanged", changedIds});
      }
      this.revision = Math.max(this.revision, next.appliedRevision);
      return didApply;
    } catch (error) {
      this.fail(error);
      throw new MapSourceSyncError(`Map source revision ${next.appliedRevision} failed; explicit resynchronization required: ${this.error}`);
    }
  }

  resynchronize(
    next: WorldMapRuntimeProjection,
    getSource: (id: RuntimeMapSourceId) => IncrementalGeoJSONSource | undefined,
  ): void {
    try {
      const nextRecords = new Map<RuntimeMapSourceId, SourceRecord>();
      for (const id of RUNTIME_MAP_SOURCE_IDS) {
        const source = getSource(id);
        if (!source) {
          if (id === MAP_SOURCE_IDS.countriesLow || id === MAP_SOURCE_IDS.bordersLow) {
            throw new MapSourceSyncError(`Required map source is missing: ${id}`);
          }
          continue;
        }
        const data = collectionOf(next, id);
        assertUniqueMapSourceIds(data, id);
        source.setData(data);
        nextRecords.set(id, {source, projection: next, mode: "resync", changedIds: data.features.map((feature) => feature.id)});
      }
      this.records = nextRecords;
      this.revision = next.appliedRevision;
      this.error = null;
      this.resyncRequired = false;
    } catch (error) {
      this.fail(error);
      throw new MapSourceSyncError(`Explicit map source resynchronization failed: ${this.error}`);
    }
  }

  async verify(getSource: (id: RuntimeMapSourceId) => IncrementalGeoJSONSource | undefined): Promise<boolean> {
    if (this.resyncRequired) return false;
    const revision = this.revision;
    for (const [id, record] of this.records) {
      const source = getSource(id);
      if (!source || source !== record.source || !source.getData) continue;
      const actual = await source.getData();
      if (revision !== this.revision || source !== getSource(id)) return false;
      if (actual.type !== "FeatureCollection") {
        this.fail(new MapSourceSyncError(`Map source ${id} returned non-collection data`));
        return false;
      }
      const expected = collectionOf(record.projection, id);
      const actualFeatures = actual as IdFeatureCollection;
      try {
        assertUniqueMapSourceIds(actualFeatures, id);
        const byId = new Map(actualFeatures.features.map((feature) => [feature.id, feature]));
        const expectedById = new Map(expected.features.map((feature) => [feature.id, feature]));
        const missingId = expected.features.find((feature) => !byId.has(feature.id))?.id;
        const idsToVerify = record.mode === "diff"
          ? record.changedIds
          : record.mode === "unchanged" ? [] : expected.features.map((feature) => feature.id);
        const mismatchId = idsToVerify.find((featureId) => {
          const feature = expectedById.get(featureId);
          const found = byId.get(featureId);
          if (!feature || !found) return feature !== found;
          return geometrySignature(found.geometry) !== geometrySignature(feature.geometry) ||
            canonicalStringify(found.properties) !== canonicalStringify(feature.properties);
        });
        if (byId.size !== expected.features.length || missingId || mismatchId) {
          const mismatch = mismatchId ? expectedById.get(mismatchId) : undefined;
          const found = mismatchId ? byId.get(mismatchId) : undefined;
          const detail = mismatchId ? `${mismatchId}: geometry=${!!found&&!!mismatch&&geometrySignature(found.geometry)===geometrySignature(mismatch.geometry)}, properties=${found?canonicalStringify(found.properties):"missing"} vs ${mismatch?canonicalStringify(mismatch.properties):"removed"}` : missingId ? `missing feature ${missingId}` : `feature count ${byId.size} vs ${expected.features.length}`;
          this.fail(new MapSourceSyncError(`Map source ${id} does not match projection revision ${revision}: ${detail}`));
          return false;
        }
      } catch (error) {
        this.fail(error);
        return false;
      }
    }
    return true;
  }
}
