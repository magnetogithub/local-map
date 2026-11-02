import type {ActiveCountryId} from "../world/country-id";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {assertSha256Hex} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {TerritoryId} from "../world/territory-id";
import type {TopologyEdgeId} from "../world/topology-state";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import {worldContentHash} from "../world/world-content-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import type {AffectedSet} from "./affected-set";

export type RootHashDelta = Readonly<{
  beforeRootHash: string;
  afterRootHash: string;
}>;

export type WorldPatchV2ModuleHashDeltas = Readonly<{
  country: RootHashDelta | null;
  territory: RootHashDelta | null;
  ownership: RootHashDelta | null;
  geometry: RootHashDelta | null;
  topology: RootHashDelta | null;
  presentation: RootHashDelta | null;
}>;

export type WorldPatchV2EntityDeltas = Readonly<{
  countryIds: readonly ActiveCountryId[];
  territoryIds: readonly TerritoryId[];
  topologyEdgeIds: readonly TopologyEdgeId[];
}>;

export type LeafHashDelta<Id extends string> = Readonly<{
  id: Id;
  beforeLeafHash: string | null;
  afterLeafHash: string | null;
}>;

export type WorldPatchV2ModuleLeafHashDeltas = Readonly<{
  countryCore: readonly LeafHashDelta<ActiveCountryId>[];
  countryPresentation: readonly LeafHashDelta<ActiveCountryId>[];
  territoryGeometry: readonly LeafHashDelta<TerritoryId>[];
  territoryOwnership: readonly LeafHashDelta<TerritoryId>[];
  topologyEdge: readonly LeafHashDelta<TopologyEdgeId>[];
}>;

export type WorldPatchV2EntityChangeSet<Id extends string> = Readonly<{
  created: readonly Id[];
  updated: readonly Id[];
  deleted: readonly Id[];
}>;

export type WorldPatchV2EntityChangeSets = Readonly<{
  countries: WorldPatchV2EntityChangeSet<ActiveCountryId>;
  territories: WorldPatchV2EntityChangeSet<TerritoryId>;
  topologyEdges: WorldPatchV2EntityChangeSet<TopologyEdgeId>;
}>;

export type WorldPatchV2 = Readonly<{
  kind: "world.patch.v2";
  schemaVersion: 1;
  commandId: string;
  beforeRevision: number;
  afterRevision: number;
  beforeContentHash: string;
  afterContentHash: string;
  entityDeltas: WorldPatchV2EntityDeltas;
  entityChangeSets: WorldPatchV2EntityChangeSets;
  moduleHashDeltas: WorldPatchV2ModuleHashDeltas;
  moduleLeafHashDeltas: WorldPatchV2ModuleLeafHashDeltas;
  plannerPatch: unknown;
}>;

export type BuildWorldPatchV2Input = Readonly<{
  commandId: string;
  beforeState: WorldStateV2;
  afterState: WorldStateV2;
  affectedSet: AffectedSet;
  plannerPatch: unknown;
}>;

const ownershipPatchKinds = new Set([
  "country.dissolve",
  "country.merge",
  "country.split",
  "territory.assign",
  "territory.transfer",
  "territory.unclaim",
]);

const geometryPatchKinds = new Set([
  "territory.partition",
  "territory.replace",
]);

export type WorldPatchSetInvariantErrorCode =
  | "duplicate-id"
  | "contradictory-membership";

export class WorldPatchSetInvariantError extends Error {
  readonly code: WorldPatchSetInvariantErrorCode;

  constructor(code: WorldPatchSetInvariantErrorCode, message: string) {
    super(message);
    this.name = "WorldPatchSetInvariantError";
    this.code = code;
  }
}

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUnique = <Id extends string>(ids: Iterable<Id>) =>
  Object.freeze([...new Set(ids)].sort(compareText));

const rootDelta = (
  beforeRootHash: string | null,
  afterRootHash: string | null,
): RootHashDelta | null => {
  if (beforeRootHash === afterRootHash) return null;
  assertSha256Hex(beforeRootHash, "WorldPatch before root hash");
  assertSha256Hex(afterRootHash, "WorldPatch after root hash");
  return Object.freeze({beforeRootHash, afterRootHash});
};

const contentHashInput = (state: WorldStateV2) => {
  const {
    countriesRootHash,
    presentationRootHash,
    territoriesRootHash,
    topologyRootHash,
  } = state.hashRoots;
  assertSha256Hex(countriesRootHash, "WorldPatch countriesRootHash");
  assertSha256Hex(presentationRootHash, "WorldPatch presentationRootHash");
  assertSha256Hex(territoriesRootHash, "WorldPatch territoriesRootHash");
  assertSha256Hex(topologyRootHash, "WorldPatch topologyRootHash");
  return {
    schemaVersion: state.schemaVersion,
    seedVersion: state.seedVersion,
    policyVersion: state.policyVersion,
    hashRoots: {
      countriesRootHash,
      presentationRootHash,
      territoriesRootHash,
      topologyRootHash,
    },
  };
};

const patchKindOf = (patch: unknown) =>
  patch && typeof patch === "object" && !Array.isArray(patch) && "kind" in patch
    ? (patch as {kind?: unknown}).kind
    : undefined;

const duplicateId = (ids: readonly string[]) => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
};

const validateChangeSet = (
  domain: string,
  changeSet: WorldPatchV2EntityChangeSet<string>,
) => {
  for (const field of ["created", "updated", "deleted"] as const) {
    const duplicate = duplicateId(changeSet[field]);
    if (duplicate) {
      throw new WorldPatchSetInvariantError(
        "duplicate-id",
        `${domain}.${field} contains duplicate id: ${duplicate}`,
      );
    }
  }

  const created = new Set(changeSet.created);
  const updated = new Set(changeSet.updated);
  const deleted = new Set(changeSet.deleted);
  for (const id of created) {
    if (updated.has(id)) {
      throw new WorldPatchSetInvariantError(
        "contradictory-membership",
        `${domain} id ${id} cannot be both created and updated`,
      );
    }
    if (deleted.has(id)) {
      throw new WorldPatchSetInvariantError(
        "contradictory-membership",
        `${domain} id ${id} cannot be both created and deleted`,
      );
    }
  }
  for (const id of updated) {
    if (deleted.has(id)) {
      throw new WorldPatchSetInvariantError(
        "contradictory-membership",
        `${domain} id ${id} cannot be both updated and deleted`,
      );
    }
  }
};

const freezeChangeSet = <Id extends string>(
  changeSet: WorldPatchV2EntityChangeSet<Id>,
): WorldPatchV2EntityChangeSet<Id> => Object.freeze({
  created: sortedUnique(changeSet.created),
  updated: sortedUnique(changeSet.updated),
  deleted: sortedUnique(changeSet.deleted),
});

export function validateWorldPatchV2EntityChangeSets(
  changeSets: WorldPatchV2EntityChangeSets,
): WorldPatchV2EntityChangeSets {
  validateChangeSet("countries", changeSets.countries);
  validateChangeSet("territories", changeSets.territories);
  validateChangeSet("topologyEdges", changeSets.topologyEdges);
  return Object.freeze({
    countries: freezeChangeSet(changeSets.countries),
    territories: freezeChangeSet(changeSets.territories),
    topologyEdges: freezeChangeSet(changeSets.topologyEdges),
  });
}

const classifyEntityChanges = <Id extends string, Entity>(
  ids: readonly Id[],
  beforeById: Readonly<Record<string, Entity>>,
  afterById: Readonly<Record<string, Entity>>,
): WorldPatchV2EntityChangeSet<Id> => {
  const created: Id[] = [];
  const updated: Id[] = [];
  const deleted: Id[] = [];

  for (const id of ids) {
    const before = beforeById[id];
    const after = afterById[id];
    if (!before && after) {
      created.push(id);
    } else if (before && !after) {
      deleted.push(id);
    } else if (before && after && before !== after) {
      updated.push(id);
    }
  }

  return {created, updated, deleted};
};

const buildEntityChangeSets = (
  beforeState: WorldStateV2,
  afterState: WorldStateV2,
  affectedSet: AffectedSet,
) => validateWorldPatchV2EntityChangeSets({
  countries: classifyEntityChanges(
    affectedSet.countryIds,
    beforeState.countriesById,
    afterState.countriesById,
  ),
  territories: classifyEntityChanges(
    affectedSet.territoryIds,
    beforeState.territoriesById,
    afterState.territoriesById,
  ),
  topologyEdges: classifyEntityChanges(
    affectedSet.topologyEdgeIds,
    beforeState.topology.edgesById,
    afterState.topology.edgesById,
  ),
});

const TERRITORY_PATCH_GEOMETRY_POLICY = Object.freeze({
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise" as const,
});

const leafDelta = <Id extends string>(
  id: Id,
  beforeLeafHash: string | null,
  afterLeafHash: string | null,
): LeafHashDelta<Id> | null => {
  if (beforeLeafHash === afterLeafHash) return null;
  if (beforeLeafHash !== null) assertSha256Hex(beforeLeafHash, "WorldPatch before leaf hash");
  if (afterLeafHash !== null) assertSha256Hex(afterLeafHash, "WorldPatch after leaf hash");
  return Object.freeze({id, beforeLeafHash, afterLeafHash});
};

const collectLeafDeltas = <Id extends string, Entity>(
  ids: readonly Id[],
  beforeById: Readonly<Record<string, Entity>>,
  afterById: Readonly<Record<string, Entity>>,
  hash: (entity: Entity) => string,
) => Object.freeze(ids.flatMap((id) => {
  const before = beforeById[id];
  const after = afterById[id];
  const delta = leafDelta(
    id,
    before ? hash(before) : null,
    after ? hash(after) : null,
  );
  return delta ? [delta] : [];
}));

const buildModuleLeafHashDeltas = (
  beforeState: WorldStateV2,
  afterState: WorldStateV2,
  affectedSet: AffectedSet,
): WorldPatchV2ModuleLeafHashDeltas => Object.freeze({
  countryCore: collectLeafDeltas(
    affectedSet.countryIds,
    beforeState.countriesById,
    afterState.countriesById,
    countryCoreLeafHash,
  ),
  countryPresentation: collectLeafDeltas(
    affectedSet.countryIds,
    beforeState.countriesById,
    afterState.countriesById,
    (country) => countryPresentationLeafHash(country, beforeState.policyVersion),
  ),
  territoryGeometry: collectLeafDeltas(
    affectedSet.territoryIds,
    beforeState.territoriesById,
    afterState.territoriesById,
    (territory) => territoryGeometryLeafHash(territory, TERRITORY_PATCH_GEOMETRY_POLICY),
  ),
  territoryOwnership: collectLeafDeltas(
    affectedSet.territoryIds,
    beforeState.territoriesById,
    afterState.territoriesById,
    territoryOwnershipLeafHash,
  ),
  topologyEdge: collectLeafDeltas(
    affectedSet.topologyEdgeIds,
    beforeState.topology.edgesById,
    afterState.topology.edgesById,
    topologyEdgeLeafHash,
  ),
});

export function buildWorldPatchV2({
  commandId,
  beforeState,
  afterState,
  affectedSet,
  plannerPatch,
}: BuildWorldPatchV2Input): WorldPatchV2 {
  const territory = rootDelta(
    beforeState.hashRoots.territoriesRootHash,
    afterState.hashRoots.territoriesRootHash,
  );
  const patchKind = patchKindOf(plannerPatch);
  const ownership = typeof patchKind === "string" && ownershipPatchKinds.has(patchKind)
    ? territory
    : null;
  const geometry = typeof patchKind === "string" && geometryPatchKinds.has(patchKind)
    ? territory
    : null;

  return Object.freeze({
    kind: "world.patch.v2",
    schemaVersion: 1,
    commandId,
    beforeRevision: beforeState.revision,
    afterRevision: afterState.revision,
    beforeContentHash: worldContentHash(contentHashInput(beforeState)),
    afterContentHash: worldContentHash(contentHashInput(afterState)),
    entityDeltas: Object.freeze({
      countryIds: Object.freeze([...affectedSet.countryIds]),
      territoryIds: Object.freeze([...affectedSet.territoryIds]),
      topologyEdgeIds: Object.freeze([...affectedSet.topologyEdgeIds]),
    }),
    entityChangeSets: buildEntityChangeSets(beforeState, afterState, affectedSet),
    moduleHashDeltas: Object.freeze({
      country: rootDelta(
        beforeState.hashRoots.countriesRootHash,
        afterState.hashRoots.countriesRootHash,
      ),
      territory,
      ownership,
      geometry,
      topology: rootDelta(
        beforeState.hashRoots.topologyRootHash,
        afterState.hashRoots.topologyRootHash,
      ),
      presentation: rootDelta(
        beforeState.hashRoots.presentationRootHash,
        afterState.hashRoots.presentationRootHash,
      ),
    }),
    moduleLeafHashDeltas: buildModuleLeafHashDeltas(beforeState, afterState, affectedSet),
    plannerPatch,
  });
}
