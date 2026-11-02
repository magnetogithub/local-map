import {canonicalSerialize} from "../world/canonical-serializer";
import {sha256Hex} from "../world/sha256";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import type {ActiveCountryId} from "../world/country-id";
import type {TerritoryGeometry, TerritoryPosition} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import type {WorldStateV2} from "../world/world-state-v2";

export type LabelModuleHashes = Readonly<{
  territoryGeometryHash: string;
  textHash: string;
  fontHash: string;
  policyHash: string;
}>;

export type LabelJob = Readonly<{
  jobId: string;
  revision: number;
  countryId: ActiveCountryId;
  territoryId: TerritoryId;
  text: string;
  anchor: readonly [number, number];
  priority: number;
  hashes: LabelModuleHashes;
}>;

export type PointLabelFeature = Readonly<{
  type: "Feature";
  id: string;
  properties: Readonly<{
    countryId: ActiveCountryId;
    territoryId: TerritoryId;
    projectionRevision: number;
    text: string;
    renderer: "point-fallback";
  }>;
  geometry: Readonly<{
    type: "Point";
    coordinates: readonly [number, number];
  }>;
}>;

export type GlyphLabelFeature = Readonly<{
  type: "Feature";
  id: string;
  properties: Readonly<{
    countryId: ActiveCountryId;
    territoryId: TerritoryId;
    projectionRevision: number;
    labelJobId: string;
    renderer: "glyph";
  }>;
  geometry: Readonly<{
    type: "Point";
    coordinates: readonly [number, number];
  }>;
}>;

export type LabelWorkerResult = Readonly<{
  jobId: string;
  revision: number;
  countryId: ActiveCountryId;
  territoryId: TerritoryId;
  hashes: LabelModuleHashes;
  glyph: GlyphLabelFeature;
}>;

export type LabelProjection = Readonly<{
  revision: number;
  appliedRevision: number;
  pointFallbacksByLabelId: ReadonlyMap<string, PointLabelFeature>;
  glyphsByLabelId: ReadonlyMap<string, GlyphLabelFeature>;
  jobs: readonly LabelJob[];
  settled: boolean;
}>;

export type LabelCache = Readonly<{
  entriesByCacheKey: ReadonlyMap<string, GlyphLabelFeature>;
  hits: number;
  misses: number;
}>;

export type LabelViewportContext = Readonly<{
  selectedCountryId?: ActiveCountryId | null;
  viewportCenter?: readonly [number, number];
}>;

export type SerializedLabelProjection = Readonly<{
  revision: number;
  jobs: readonly LabelJob[];
}>;

export function serializeLabelProjection(projection: LabelProjection): SerializedLabelProjection {
  return Object.freeze({revision: projection.revision, jobs: projection.jobs});
}

export function deserializeLabelProjection(serialized: SerializedLabelProjection): LabelProjection {
  const pointFallbacksByLabelId = new Map<string, PointLabelFeature>();
  for (const job of serialized.jobs) pointFallbacksByLabelId.set(job.jobId, pointFallback(job));
  return Object.freeze({
    revision: serialized.revision,
    appliedRevision: serialized.revision,
    jobs: serialized.jobs,
    pointFallbacksByLabelId,
    glyphsByLabelId: new Map(),
    settled: serialized.jobs.length === 0,
  });
}

const GEOMETRY_HASH_POLICY = Object.freeze({
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise" as const,
});

const DEFAULT_FONT_HASH = "font:runtime-default";
const DEFAULT_POLICY_HASH = "label-policy:runtime-v1";

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const hashCanonical = (value: unknown) => sha256Hex(canonicalSerialize(value));
const labelIdOf = (countryId: ActiveCountryId, territoryId: TerritoryId) =>
  `${countryId}:${territoryId}`;

const positionsOf = (geometry: TerritoryGeometry): TerritoryPosition[] => {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((polygon) => polygon.flatMap((ring) => [...ring]));
};

export function representativePointForTerritory(
  geometry: TerritoryGeometry,
): readonly [number, number] {
  const positions = positionsOf(geometry);
  const longitudes = positions.map(([longitude]) => longitude);
  const latitudes = positions.map(([, latitude]) => latitude);
  return Object.freeze([
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    (Math.min(...latitudes) + Math.max(...latitudes)) / 2,
  ]) as readonly [number, number];
}

export const labelTextHash = (text: string) => hashCanonical({namespace: "labelText", text});

export function labelCacheKey(hashes: LabelModuleHashes): string {
  return hashCanonical({namespace: "labelCache", ...hashes});
}

function labelPriority(
  countryId: ActiveCountryId,
  anchor: readonly [number, number],
  context: LabelViewportContext,
) {
  const selectionBoost = context.selectedCountryId === countryId ? -10_000 : 0;
  const center = context.viewportCenter ?? [0, 0];
  return selectionBoost + Math.hypot(anchor[0] - center[0], anchor[1] - center[1]);
}

function pointFallback(job: LabelJob): PointLabelFeature {
  return Object.freeze({
    type: "Feature" as const,
    id: job.jobId,
    properties: Object.freeze({
      countryId: job.countryId,
      territoryId: job.territoryId,
      projectionRevision: job.revision,
      text: job.text,
      renderer: "point-fallback" as const,
    }),
    geometry: Object.freeze({
      type: "Point" as const,
      coordinates: job.anchor,
    }),
  });
}

export function createLabelProjection(
  state: WorldStateV2,
  context: LabelViewportContext = {},
  previous?: Readonly<{state:WorldStateV2;projection:LabelProjection}>,
): LabelProjection {
  const jobs: LabelJob[] = [];
  const pointFallbacksByLabelId = new Map<string, PointLabelFeature>();
  const previousJobsByTerritoryId = new Map(previous?.projection.jobs.map(job=>[job.territoryId,job])??[]);
  for (const territoryId of state.territoryOrder) {
    const territory = state.territoriesById[territoryId];
    if (territory.ownerCountryId === null) continue;
    const country = state.countriesById[territory.ownerCountryId];
    if (!country) continue;
    const previousTerritory=previous?.state.territoriesById[territoryId];
    const previousJob=previousJobsByTerritoryId.get(territoryId);
    const reusable=territory===previousTerritory&&previousJob?.text===country.names.mapKo;
    const anchor = reusable ? previousJob.anchor : representativePointForTerritory(territory.geometry);
    const hashes = reusable ? previousJob.hashes : Object.freeze({
      territoryGeometryHash: territoryGeometryLeafHash(territory, GEOMETRY_HASH_POLICY),
      textHash: labelTextHash(country.names.mapKo),
      fontHash: DEFAULT_FONT_HASH,
      policyHash: DEFAULT_POLICY_HASH,
    });
    const jobId = labelIdOf(country.id, territory.id);
    const job = Object.freeze({
      jobId,
      revision: state.revision,
      countryId: country.id,
      territoryId: territory.id,
      text: country.names.mapKo,
      anchor,
      priority: labelPriority(country.id, anchor, context),
      hashes,
    });
    jobs.push(job);
    pointFallbacksByLabelId.set(jobId, pointFallback(job));
  }
  jobs.sort((left, right) =>
    left.priority - right.priority ||
    compareText(left.countryId, right.countryId) ||
    compareText(left.territoryId, right.territoryId),
  );
  return Object.freeze({
    revision: state.revision,
    appliedRevision: state.revision,
    pointFallbacksByLabelId,
    glyphsByLabelId: new Map(),
    jobs: Object.freeze(jobs),
    settled: jobs.length === 0,
  });
}

export function runPureGlyphWorker(job: LabelJob): LabelWorkerResult {
  const glyph = Object.freeze({
    type: "Feature" as const,
    id: job.jobId,
    properties: Object.freeze({
      countryId: job.countryId,
      territoryId: job.territoryId,
      projectionRevision: job.revision,
      labelJobId: job.jobId,
      renderer: "glyph" as const,
    }),
    geometry: Object.freeze({
      type: "Point" as const,
      coordinates: job.anchor,
    }),
  });
  return Object.freeze({
    jobId: job.jobId,
    revision: job.revision,
    countryId: job.countryId,
    territoryId: job.territoryId,
    hashes: job.hashes,
    glyph,
  });
}

export function createLabelCache(): LabelCache {
  return Object.freeze({
    entriesByCacheKey: new Map(),
    hits: 0,
    misses: 0,
  });
}

export function readOrComputeGlyph(
  cache: LabelCache,
  job: LabelJob,
): Readonly<{cache: LabelCache; result: LabelWorkerResult}> {
  const cacheKey = labelCacheKey(job.hashes);
  const cached = cache.entriesByCacheKey.get(cacheKey);
  if (cached) {
    return Object.freeze({
      cache: Object.freeze({
        entriesByCacheKey: cache.entriesByCacheKey,
        hits: cache.hits + 1,
        misses: cache.misses,
      }),
      result: Object.freeze({
        jobId: job.jobId,
        revision: job.revision,
        countryId: job.countryId,
        territoryId: job.territoryId,
        hashes: job.hashes,
        glyph: Object.freeze({
          ...cached,
          id: job.jobId,
          properties: Object.freeze({
            ...cached.properties,
            countryId: job.countryId,
            territoryId: job.territoryId,
            projectionRevision: job.revision,
            labelJobId: job.jobId,
          }),
        }),
      }),
    });
  }
  const result = runPureGlyphWorker(job);
  const entriesByCacheKey = new Map(cache.entriesByCacheKey);
  entriesByCacheKey.set(cacheKey, result.glyph);
  return Object.freeze({
    cache: Object.freeze({
      entriesByCacheKey,
      hits: cache.hits,
      misses: cache.misses + 1,
    }),
    result,
  });
}

export function isStaleLabelResult(
  projection: LabelProjection,
  result: LabelWorkerResult,
): boolean {
  const job = projection.jobs.find((candidate) => candidate.jobId === result.jobId);
  return !job ||
    result.revision !== projection.revision ||
    result.countryId !== job.countryId ||
    result.territoryId !== job.territoryId ||
    result.glyph.properties.projectionRevision !== job.revision ||
    result.glyph.properties.labelJobId !== job.jobId ||
    result.hashes.territoryGeometryHash !== job.hashes.territoryGeometryHash ||
    result.hashes.textHash !== job.hashes.textHash ||
    result.hashes.fontHash !== job.hashes.fontHash ||
    result.hashes.policyHash !== job.hashes.policyHash;
}

export function applyGlyphResult(
  projection: LabelProjection,
  result: LabelWorkerResult,
): LabelProjection {
  if (isStaleLabelResult(projection, result)) return projection;
  const pointFallbacksByLabelId = new Map(projection.pointFallbacksByLabelId);
  const glyphsByLabelId = new Map(projection.glyphsByLabelId);
  pointFallbacksByLabelId.delete(result.jobId);
  glyphsByLabelId.set(result.jobId, result.glyph);
  return Object.freeze({
    revision: projection.revision,
    appliedRevision: projection.appliedRevision,
    pointFallbacksByLabelId,
    glyphsByLabelId,
    jobs: projection.jobs,
    settled: pointFallbacksByLabelId.size === 0 && glyphsByLabelId.size === projection.jobs.length,
  });
}

export function countSettledLabelProblems(projection: LabelProjection): number {
  if (!projection.settled) return projection.jobs.length;
  let problems = 0;
  for (const job of projection.jobs) {
    const hasPoint = projection.pointFallbacksByLabelId.has(job.jobId);
    const hasGlyph = projection.glyphsByLabelId.has(job.jobId);
    if (hasPoint || !hasGlyph) problems += 1;
  }
  return problems;
}
