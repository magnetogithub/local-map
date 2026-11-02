import {canonicalSerialize,canonicalStringify} from "../world/canonical-serializer";
import {sha256Hex} from "../world/sha256";
import type {WorldPatchV2} from "../planning/world-patch-v2";
import type {TerritoryGeometry} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import type {WorldStateV2} from "../world/world-state-v2";
import {
  createTerritoryPolygonIndexProjection,
  type TerritoryPolygonFeatureBucket,
} from "./territory-polygon-index";

export type ProjectionMeta = Readonly<{
  appliedRevision: number;
  artifactHash: string;
}>;

export type MapSourceResolution = "low" | "high";

export type RuntimeMapFeatureProperties = Readonly<{
  territoryId: TerritoryId;
  ownerCountryId: string | null;
  displayName: string | null;
  projectionRevision: number;
  sourceResolution: MapSourceResolution;
  /**
   * Legacy compatibility only. Runtime truth must use territoryId + ownerCountryId.
   */
  countryId: string | null;
}>;

export type RuntimeMapFeature = Readonly<{
  type: "Feature";
  id: TerritoryId;
  properties: RuntimeMapFeatureProperties;
  geometry: TerritoryGeometry;
}>;

export type RuntimeMapFeatureCollection = Readonly<{
  type: "FeatureCollection";
  features: readonly RuntimeMapFeature[];
}>;

export type SynchronizedMapSource = Readonly<{
  resolution: MapSourceResolution;
  meta: ProjectionMeta;
  featureCollection: RuntimeMapFeatureCollection;
}>;

export type SynchronizedMapSources = Readonly<{
  low: SynchronizedMapSource;
  high: SynchronizedMapSource;
}>;

export type ProjectionRecord = Readonly<{
  name: string;
  value: unknown;
  meta: ProjectionMeta;
  status: "ready" | "failed";
  lastError: string | null;
  retryRevision: number | null;
}>;

export type ProjectionCoordinator = Readonly<{
  records: ReadonlyMap<string, ProjectionRecord>;
  lastCommittedRevision: number;
}>;

export type ProjectionAdapter = Readonly<{
  name: string;
  build: (state: WorldStateV2) => unknown;
  applyPatch: (current: unknown, patch: WorldPatchV2, state: WorldStateV2) => unknown;
  artifactHash: (value: unknown) => string;
}>;

export type ProjectionCoordinatorApplyResult = Readonly<{
  coordinator: ProjectionCoordinator;
  staleRejected: boolean;
  failedProjectionNames: readonly string[];
}>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const hashCanonical = (value: unknown) => sha256Hex(canonicalSerialize(value));

export function mapTerritoryOwnerSetHash(
  state: WorldStateV2,
): string {
  return hashCanonical({
    namespace: "mapTerritoryOwnerSet",
    revision: state.revision,
    territories: state.territoryOrder.map((territoryId) => {
      const territory = state.territoriesById[territoryId];
      return {
        territoryId,
        ownerCountryId: territory.ownerCountryId,
      };
    }),
  });
}

const mapFeature = (
  bucket: TerritoryPolygonFeatureBucket,
  state: WorldStateV2,
  revision: number,
  resolution: MapSourceResolution,
): RuntimeMapFeature => {
  const [feature] = bucket.features;
  return Object.freeze({
    type: "Feature" as const,
    id: bucket.territoryId,
    properties: Object.freeze({
      territoryId: bucket.territoryId,
      ownerCountryId: bucket.ownerCountryId,
      displayName: bucket.ownerCountryId === null
        ? null
        : state.countriesById[bucket.ownerCountryId]?.names.mapKo ?? null,
      projectionRevision: revision,
      sourceResolution: resolution,
      countryId: bucket.ownerCountryId,
    }),
    geometry: feature.geometry,
  });
};

const featureCollection = (
  buckets: readonly TerritoryPolygonFeatureBucket[],
  state: WorldStateV2,
  revision: number,
  resolution: MapSourceResolution,
  previous?: SynchronizedMapSource,
  changedTerritoryIds?: ReadonlySet<TerritoryId>,
): RuntimeMapFeatureCollection => Object.freeze({
  type: "FeatureCollection" as const,
  features: Object.freeze((() => {
    const previousById = new Map(previous?.featureCollection.features.map((feature) => [feature.id, feature]) ?? []);
    return buckets.map((bucket) => {
      const existing = previousById.get(bucket.territoryId);
      return existing && !changedTerritoryIds?.has(bucket.territoryId)
        ? existing
        : mapFeature(bucket, state, revision, resolution);
    });
  })()),
});

const sourcesFromPolygonProjection = (
  state: WorldStateV2,
  territoryProjection: ReturnType<typeof createTerritoryPolygonIndexProjection>,
  previous?: SynchronizedMapSources,
  changedTerritoryIds?: ReadonlySet<TerritoryId>,
): SynchronizedMapSources => {
  const buckets = Object.freeze([...territoryProjection.bucketsByTerritoryId.values()]
    .sort((left, right) => compareText(left.territoryId, right.territoryId)));
  const artifactHash = mapTerritoryOwnerSetHash(state);
  const meta = Object.freeze({appliedRevision: state.revision, artifactHash});
  return Object.freeze({
    low: Object.freeze({
      resolution: "low" as const,
      meta,
      featureCollection: featureCollection(buckets, state, state.revision, "low", previous?.low, changedTerritoryIds),
    }),
    high: Object.freeze({
      resolution: "high" as const,
      meta,
      featureCollection: featureCollection(buckets, state, state.revision, "high", previous?.high, changedTerritoryIds),
    }),
  });
};

export function createSynchronizedMapSources(state: WorldStateV2): SynchronizedMapSources {
  return sourcesFromPolygonProjection(state, createTerritoryPolygonIndexProjection(state));
}

const changedSourceTerritoryIds = (
  current: SynchronizedMapSources,
  state: WorldStateV2,
): Set<TerritoryId> => {
  const oldFeatures = new Map(current.low.featureCollection.features.map((feature) => [feature.id, feature]));
  return new Set<TerritoryId>(state.territoryOrder.filter((id) => {
    const old = oldFeatures.get(id);
    const territory = state.territoriesById[id];
    return !old || old.properties.ownerCountryId !== territory.ownerCountryId ||
      old.properties.displayName !== (territory.ownerCountryId === null
        ? null
        : state.countriesById[territory.ownerCountryId]?.names.mapKo ?? null) ||
      (old.geometry !== territory.geometry &&
        canonicalStringify(old.geometry) !== canonicalStringify(territory.geometry));
  }));
};

export function applySynchronizedMapSourcesPatch(
  current: SynchronizedMapSources,
  patch: WorldPatchV2,
  state: WorldStateV2,
): SynchronizedMapSources {
  if (current.low.meta.appliedRevision !== patch.beforeRevision ||
      current.high.meta.appliedRevision !== patch.beforeRevision) {
    throw new Error(`Map source revision does not match patch beforeRevision ${patch.beforeRevision}`);
  }
  if (state.revision !== patch.afterRevision) {
    throw new Error(`Map source state revision does not match patch afterRevision ${patch.afterRevision}`);
  }
  const changed = changedSourceTerritoryIds(current, state);
  for (const id of [
    ...patch.entityChangeSets.territories.created,
    ...patch.entityChangeSets.territories.updated,
    ...patch.entityChangeSets.territories.deleted,
  ]) changed.add(id);
  return sourcesFromPolygonProjection(state, createTerritoryPolygonIndexProjection(state), current, changed);
}

export function reconcileSynchronizedMapSources(
  current: SynchronizedMapSources,
  state: WorldStateV2,
): SynchronizedMapSources {
  if (state.revision <= current.low.meta.appliedRevision ||
      current.low.meta.appliedRevision !== current.high.meta.appliedRevision) {
    throw new Error("Map source reconciliation requires a newer state and synchronized sources");
  }
  const changed = changedSourceTerritoryIds(current, state);
  return sourcesFromPolygonProjection(state, createTerritoryPolygonIndexProjection(state), current, changed);
}

export function mapSourceTerritoryOwnerSignature(
  source: SynchronizedMapSource,
): readonly string[] {
  return Object.freeze(source.featureCollection.features
    .map(({properties}) => `${properties.territoryId}:${properties.ownerCountryId ?? "null"}:${properties.displayName ?? "null"}`)
    .sort(compareText));
}

export const synchronizedMapSourcesArtifactHash = (sources: SynchronizedMapSources) =>
  hashCanonical({
    namespace: "synchronizedMapSources",
    low: mapSourceTerritoryOwnerSignature(sources.low),
    high: mapSourceTerritoryOwnerSignature(sources.high),
    lowRevision: sources.low.meta.appliedRevision,
    highRevision: sources.high.meta.appliedRevision,
  });

export const synchronizedMapSourcesAdapter: ProjectionAdapter = {
  name: "map",
  build: createSynchronizedMapSources,
  applyPatch: (current: unknown, patch: WorldPatchV2, state: WorldStateV2) =>
    applySynchronizedMapSourcesPatch(current as SynchronizedMapSources, patch, state),
  artifactHash: (value: unknown) => synchronizedMapSourcesArtifactHash(
    value as SynchronizedMapSources,
  ),
};

const recordFromValue = (
  adapter: ProjectionAdapter,
  value: unknown,
  revision: number,
): ProjectionRecord => Object.freeze({
  name: adapter.name,
  value,
  meta: Object.freeze({
    appliedRevision: revision,
    artifactHash: adapter.artifactHash(value),
  }),
  status: "ready" as const,
  lastError: null,
  retryRevision: null,
});

export function createProjectionCoordinator(
  state: WorldStateV2,
  adapters: readonly ProjectionAdapter[],
): ProjectionCoordinator {
  return Object.freeze({
    records: new Map(adapters.map((adapter) => [
      adapter.name,
      recordFromValue(adapter, adapter.build(state), state.revision),
    ])),
    lastCommittedRevision: state.revision,
  });
}

export function applyProjectionCoordinatorPatch(
  coordinator: ProjectionCoordinator,
  adapters: readonly ProjectionAdapter[],
  patch: WorldPatchV2,
  committedState: WorldStateV2,
): ProjectionCoordinatorApplyResult {
  if (committedState.revision !== patch.afterRevision) {
    throw new Error(
      `Committed state revision ${committedState.revision} does not match patch afterRevision ${patch.afterRevision}`,
    );
  }
  const records = new Map(coordinator.records);
  const hasStaleRecord = [...records.values()].some((record) =>
    record.meta.appliedRevision !== patch.beforeRevision
  );
  if (hasStaleRecord) {
    return Object.freeze({
      coordinator,
      staleRejected: true,
      failedProjectionNames: Object.freeze([]),
    });
  }

  const failedProjectionNames: string[] = [];
  for (const adapter of adapters) {
    const current = records.get(adapter.name);
    if (!current) throw new Error(`Projection adapter is not registered: ${adapter.name}`);
    try {
      records.set(
        adapter.name,
        recordFromValue(
          adapter,
          adapter.applyPatch(current.value, patch, committedState),
          committedState.revision,
        ),
      );
    } catch (error) {
      failedProjectionNames.push(adapter.name);
      records.set(adapter.name, Object.freeze({
        ...current,
        status: "failed" as const,
        lastError: error instanceof Error ? error.message : String(error),
        retryRevision: committedState.revision,
      }));
    }
  }

  return Object.freeze({
    coordinator: Object.freeze({
      records,
      lastCommittedRevision: committedState.revision,
    }),
    staleRejected: false,
    failedProjectionNames: Object.freeze(failedProjectionNames),
  });
}

export function retryFailedProjections(
  coordinator: ProjectionCoordinator,
  adapters: readonly ProjectionAdapter[],
  latestState: WorldStateV2,
): ProjectionCoordinator {
  const records = new Map(coordinator.records);
  for (const adapter of adapters) {
    const current = records.get(adapter.name);
    if (current?.status !== "failed") continue;
    records.set(adapter.name, recordFromValue(adapter, adapter.build(latestState), latestState.revision));
  }
  return Object.freeze({
    records,
    lastCommittedRevision: Math.max(coordinator.lastCommittedRevision, latestState.revision),
  });
}
