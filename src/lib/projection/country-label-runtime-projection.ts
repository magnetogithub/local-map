import {
  applyGlyphResult,
  runPureGlyphWorker,
  type LabelJob,
  type LabelProjection,
} from "./label-projection-checkpoint";

type SeedFeature = Readonly<{
  type: "Feature";
  properties: Readonly<Record<string, unknown>>;
  geometry: Readonly<{type: string; coordinates: unknown}>;
}>;

export type LabelSeedCollection = Readonly<{
  type: "FeatureCollection";
  features: readonly SeedFeature[];
}>;

export type LabelSeedCache = Readonly<{
  placements: LabelSeedCollection;
  fills: LabelSeedCollection;
  outlines: LabelSeedCollection;
}>;

export type LabelMapSources = Readonly<{
  appliedRevision: number;
  placements: LabelSeedCollection;
  fills: LabelSeedCollection;
  outlines: LabelSeedCollection;
  projection: LabelProjection;
}>;

const collection = (features: readonly SeedFeature[]): LabelSeedCollection => ({
  type: "FeatureCollection",
  features,
});

export const emptyLabelSeedCollection: LabelSeedCollection = collection([]);

export function labelRuntimeCacheKeys(job: LabelJob) {
  return Object.freeze({
    geometry: `${job.countryId}:${job.hashes.territoryGeometryHash}:${job.hashes.policyHash}`,
    text: `${job.countryId}:${job.hashes.textHash}:${job.hashes.fontHash}`,
  });
}

const countryIdOf = (feature: SeedFeature) => feature.properties.countryId;

const finiteNumber = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function synthesizeMergedCountryPlacement(
  countryId: string,
  jobs: readonly LabelJob[],
  seedProjection: LabelProjection,
  placementsByCountryId: ReadonlyMap<unknown, SeedFeature>,
  revision: number,
): SeedFeature | null {
  const previousJobsByTerritoryId = new Map(
    seedProjection.jobs.map((job) => [job.territoryId, job]),
  );
  const sourceCountryIds = [...new Set(jobs
    .map((job) => previousJobsByTerritoryId.get(job.territoryId)?.countryId)
    .filter((value): value is LabelJob["countryId"] => value !== undefined))];
  if (sourceCountryIds.length < 2) return null;
  const sources = sourceCountryIds
    .map((sourceCountryId) => placementsByCountryId.get(sourceCountryId))
    .filter((feature): feature is SeedFeature => feature !== undefined)
    .filter((feature) => Array.isArray(feature.geometry.coordinates));
  if (sources.length < 2) return null;

  const weights = sources.map((feature) => Math.max(1, finiteNumber(feature.properties.area, 1)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const firstLongitude = (sources[0].geometry.coordinates as number[])[0];
  const unwrapLongitude = (longitude: number) => {
    while (longitude - firstLongitude > 180) longitude -= 360;
    while (longitude - firstLongitude < -180) longitude += 360;
    return longitude;
  };
  let longitude = sources.reduce((sum, feature, index) =>
    sum + unwrapLongitude((feature.geometry.coordinates as number[])[0]) * weights[index], 0) / totalWeight;
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  const latitude = sources.reduce((sum, feature, index) =>
    sum + (feature.geometry.coordinates as number[])[1] * weights[index], 0) / totalWeight;
  const doubledAngles = sources.map((feature) => finiteNumber(feature.properties.angle, 0) * Math.PI / 90);
  const angle = Math.atan2(
    doubledAngles.reduce((sum, value, index) => sum + Math.sin(value) * weights[index], 0),
    doubledAngles.reduce((sum, value, index) => sum + Math.cos(value) * weights[index], 0),
  ) * 90 / Math.PI;
  const fontSizeWorldUnits = Math.max(...sources.map((feature) =>
    finiteNumber(feature.properties.fontSizeWorldUnits, 1)));
  const targetTextWidthWorld = Math.max(...sources.map((feature) =>
    finiteNumber(feature.properties.targetTextWidthWorld, fontSizeWorldUnits)));
  const template = sources[0];
  return {
    type: "Feature",
    properties: {
      ...template.properties,
      countryId,
      territoryId: jobs[0].territoryId,
      mapLabelKo: jobs[0].text,
      nameKo: jobs[0].text,
      placementMode: "small-country-point",
      overlapAtClose: false,
      minZoom: Math.min(...sources.map((feature) => finiteNumber(feature.properties.minZoom, 1))),
      priority: Math.min(...jobs.map((job) => job.priority)),
      angle,
      letterSpacing: 0.06,
      fontSizeWorldUnits,
      targetTextWidthWorld,
      projectionRevision: revision,
      labelJobId: jobs[0].jobId,
    },
    geometry: {type: "Point", coordinates: [longitude, latitude]},
  };
}

export function projectLabelMapSources(
  projection: LabelProjection,
  seedProjection: LabelProjection,
  seed: LabelSeedCache,
): LabelMapSources {
  if (projection.appliedRevision !== projection.revision) {
    throw new Error("Label projection revision mismatch");
  }
  const seedJobs = new Map(seedProjection.jobs.map((job) => [job.jobId, job]));
  const placementsByCountryId = new Map(seed.placements.features.map((feature) => [countryIdOf(feature), feature]));
  const cachedGlyphCountryIds = new Set([...seed.fills.features,...seed.outlines.features].map(countryIdOf));
  const placements: SeedFeature[] = [];
  const glyphCountries = new Set<string>();
  let settled = projection;
  const jobsByCountry = new Map<string, LabelJob[]>();
  for (const job of projection.jobs) jobsByCountry.set(job.countryId,[...(jobsByCountry.get(job.countryId)??[]),job]);

  for (const [countryId, jobs] of jobsByCountry) {
    const cachedPlacement = placementsByCountryId.get(countryId);
    const mergedPlacement = synthesizeMergedCountryPlacement(
      countryId,
      jobs,
      seedProjection,
      placementsByCountryId,
      projection.revision,
    );
    const cachedCoordinates = cachedPlacement?.geometry.coordinates;
    const coordinates = Array.isArray(cachedCoordinates) &&
      typeof cachedCoordinates[0] === "number" && typeof cachedCoordinates[1] === "number"
      ? cachedCoordinates as number[] : null;
    const job = coordinates ? [...jobs].sort((left,right) =>
      Math.hypot(left.anchor[0]-coordinates[0],left.anchor[1]-coordinates[1]) -
      Math.hypot(right.anchor[0]-coordinates[0],right.anchor[1]-coordinates[1]))[0] : jobs[0];
    const baseline = seedJobs.get(job.jobId);
    const geometryValid = jobs.every((candidate) => {
      const seedJob = seedJobs.get(candidate.jobId);
      return seedJob !== undefined &&
        labelRuntimeCacheKeys(seedJob).geometry === labelRuntimeCacheKeys(candidate).geometry;
    });
    const textValid = baseline !== undefined &&
      labelRuntimeCacheKeys(baseline).text === labelRuntimeCacheKeys(job).text &&
      (cachedPlacement === undefined || cachedPlacement.properties.mapLabelKo === job.text);
    const canReuseGlyph = geometryValid && textValid && cachedGlyphCountryIds.has(countryId);
    if (mergedPlacement) {
      placements.push(mergedPlacement);
    } else if (cachedPlacement && geometryValid) {
      placements.push({
        ...cachedPlacement,
        properties: {
          ...cachedPlacement.properties,
          mapLabelKo: job.text,
          projectionRevision: projection.revision,
          labelJobId: job.jobId,
        },
      });
    } else if (!canReuseGlyph) {
      placements.push({
        type: "Feature",
        properties: {
          countryId: job.countryId,
          territoryId: job.territoryId,
          mapLabelKo: job.text,
          nameKo: job.text,
          placementMode: "small-country-point",
          overlapAtClose: false,
          minZoom: 1,
          priority: job.priority,
          angle: 0,
          letterSpacing: 0,
          fontSizeWorldUnits: 1,
          projectionRevision: projection.revision,
          labelJobId: job.jobId,
        },
        geometry: {type: "Point", coordinates: job.anchor},
      });
    }
    if (canReuseGlyph) {
      glyphCountries.add(job.countryId);
      settled = applyGlyphResult(settled, runPureGlyphWorker(job));
    }
  }

  const cachedGlyphs = (source: LabelSeedCollection) => collection(source.features
    .filter((feature) => glyphCountries.has(String(countryIdOf(feature))))
    .map((feature) => ({
      ...feature,
      properties: {...feature.properties, projectionRevision: projection.revision},
    })));

  return Object.freeze({
    appliedRevision: projection.revision,
    placements: collection(placements),
    fills: cachedGlyphs(seed.fills),
    outlines: cachedGlyphs(seed.outlines),
    projection: settled,
  });
}

export function shouldApplyLabelMapSources(currentRevision: number, next: LabelMapSources): boolean {
  return next.appliedRevision > currentRevision;
}
