import type {ActiveCountryId} from "../world/country-id";
import type {WorldPatchV2} from "../planning/world-patch-v2";
import type {TerritoryEntity, TerritoryGeometry, TerritoryPropertyValue} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import type {WorldStateV2} from "../world/world-state-v2";

export type TerritoryPolygonFeatureProperties = Readonly<{
  territoryId: TerritoryId;
  ownerCountryId: ActiveCountryId | null;
  sourceFeatureId: TerritoryPropertyValue | null;
}>;

export type TerritoryPolygonFeature = Readonly<{
  type: "Feature";
  id: TerritoryId;
  properties: TerritoryPolygonFeatureProperties;
  geometry: TerritoryGeometry;
}>;

export type TerritoryPolygonFeatureBucket = Readonly<{
  territoryId: TerritoryId;
  ownerCountryId: ActiveCountryId | null;
  features: readonly TerritoryPolygonFeature[];
}>;

export type TerritoryPolygonIndexProjection = Readonly<{
  revision: number;
  bucketsByTerritoryId: ReadonlyMap<TerritoryId, TerritoryPolygonFeatureBucket>;
  territoryIdsByOwnerCountryId: ReadonlyMap<ActiveCountryId, readonly TerritoryId[]>;
}>;

export type TerritoryPolygonIndexPatchResult = Readonly<{
  projection: TerritoryPolygonIndexProjection;
  changedTerritoryIds: readonly TerritoryId[];
  added: readonly TerritoryId[];
  replaced: readonly TerritoryId[];
  deleted: readonly TerritoryId[];
}>;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const polygonFeature = (territory: TerritoryEntity): TerritoryPolygonFeature => Object.freeze({
  type: "Feature" as const,
  id: territory.id,
  properties: Object.freeze({
    territoryId: territory.id,
    ownerCountryId: territory.ownerCountryId,
    sourceFeatureId: territory.properties.sourceFeatureId ?? null,
  }),
  geometry: territory.geometry,
});

const featureBucket = (territory: TerritoryEntity): TerritoryPolygonFeatureBucket => Object.freeze({
  territoryId: territory.id,
  ownerCountryId: territory.ownerCountryId,
  features: Object.freeze([polygonFeature(territory)]),
});

const changedTerritoryIdsOf = (patch: WorldPatchV2) => Object.freeze([
  ...patch.entityChangeSets.territories.created,
  ...patch.entityChangeSets.territories.updated,
  ...patch.entityChangeSets.territories.deleted,
]);

const rebuildOwnerIndex = (
  bucketsByTerritoryId: ReadonlyMap<TerritoryId, TerritoryPolygonFeatureBucket>,
) => {
  const ownerBuckets = new Map<ActiveCountryId, TerritoryId[]>();
  for (const bucket of bucketsByTerritoryId.values()) {
    if (bucket.ownerCountryId !== null) {
      ownerBuckets.set(bucket.ownerCountryId, [
        ...(ownerBuckets.get(bucket.ownerCountryId) ?? []),
        bucket.territoryId,
      ]);
    }
  }
  const territoryIdsByOwnerCountryId = new Map<ActiveCountryId, readonly TerritoryId[]>();
  for (const [countryId, territoryIds] of [...ownerBuckets.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    territoryIdsByOwnerCountryId.set(
      countryId,
      Object.freeze([...territoryIds].sort(compareText)),
    );
  }
  return territoryIdsByOwnerCountryId;
};

export function createTerritoryPolygonIndexProjection(
  state: WorldStateV2,
): TerritoryPolygonIndexProjection {
  const bucketsByTerritoryId = new Map<TerritoryId, TerritoryPolygonFeatureBucket>();

  for (const territoryId of state.territoryOrder) {
    const territory = state.territoriesById[territoryId];
    const bucket = featureBucket(territory);
    bucketsByTerritoryId.set(territoryId, bucket);
  }

  return Object.freeze({
    revision: state.revision,
    bucketsByTerritoryId,
    territoryIdsByOwnerCountryId: rebuildOwnerIndex(bucketsByTerritoryId),
  });
}

export function applyTerritoryPolygonIndexPatch(
  projection: TerritoryPolygonIndexProjection,
  patch: WorldPatchV2,
  committedState: WorldStateV2,
): TerritoryPolygonIndexPatchResult {
  if (projection.revision !== patch.beforeRevision) {
    throw new Error(
      `Territory polygon projection revision ${projection.revision} does not match patch beforeRevision ${patch.beforeRevision}`,
    );
  }
  if (committedState.revision !== patch.afterRevision) {
    throw new Error(
      `Committed state revision ${committedState.revision} does not match patch afterRevision ${patch.afterRevision}`,
    );
  }

  const bucketsByTerritoryId = new Map(projection.bucketsByTerritoryId);
  for (const territoryId of patch.entityChangeSets.territories.deleted) {
    bucketsByTerritoryId.delete(territoryId);
  }
  for (const territoryId of [
    ...patch.entityChangeSets.territories.created,
    ...patch.entityChangeSets.territories.updated,
  ]) {
    const territory = committedState.territoriesById[territoryId];
    if (!territory) {
      throw new Error(`Territory polygon patch references missing territory: ${territoryId}`);
    }
    bucketsByTerritoryId.set(territoryId, featureBucket(territory));
  }

  return Object.freeze({
    projection: Object.freeze({
      revision: patch.afterRevision,
      bucketsByTerritoryId,
      territoryIdsByOwnerCountryId: rebuildOwnerIndex(bucketsByTerritoryId),
    }),
    changedTerritoryIds: changedTerritoryIdsOf(patch),
    added: Object.freeze([...patch.entityChangeSets.territories.created]),
    replaced: Object.freeze([...patch.entityChangeSets.territories.updated]),
    deleted: Object.freeze([...patch.entityChangeSets.territories.deleted]),
  });
}

export function getTerritoryPolygonBucket(
  projection: TerritoryPolygonIndexProjection,
  territoryId: TerritoryId,
): TerritoryPolygonFeatureBucket | null {
  return projection.bucketsByTerritoryId.get(territoryId) ?? null;
}

export function getOwnerTerritoryPolygonBuckets(
  projection: TerritoryPolygonIndexProjection,
  ownerCountryId: ActiveCountryId,
): readonly TerritoryPolygonFeatureBucket[] {
  return Object.freeze(
    (projection.territoryIdsByOwnerCountryId.get(ownerCountryId) ?? [])
      .map((territoryId) => projection.bucketsByTerritoryId.get(territoryId))
      .filter((bucket): bucket is TerritoryPolygonFeatureBucket => bucket !== undefined),
  );
}
