import type {TopologyEdgeId} from "../world/topology-state";
import type {WorldStateV2} from "../world/world-state-v2";
import type {AffectedSet} from "./affected-set";

export type StructuralSharingReport = Readonly<{
  unaffectedCountryReferenceChanges: readonly string[];
  unaffectedTerritoryReferenceChanges: readonly string[];
  unaffectedTopologyEdgeReferenceChanges: readonly TopologyEdgeId[];
  deepCloneCount: number;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const sorted = <Id extends string>(ids: Iterable<Id>) =>
  Object.freeze([...ids].sort(compareText));

export function inspectNextStateStructuralSharing(
  beforeState: WorldStateV2,
  nextState: WorldStateV2,
  affectedSet: AffectedSet,
): StructuralSharingReport {
  const affectedCountryIds = new Set(affectedSet.countryIds);
  const affectedTerritoryIds = new Set(affectedSet.territoryIds);
  const affectedTopologyEdgeIds = new Set(affectedSet.topologyEdgeIds);

  const unaffectedCountryReferenceChanges = Object.keys(beforeState.countriesById)
    .filter((countryId) =>
      !affectedCountryIds.has(countryId as never) &&
      nextState.countriesById[countryId] &&
      beforeState.countriesById[countryId] !== nextState.countriesById[countryId]
    );
  const unaffectedTerritoryReferenceChanges = Object.keys(beforeState.territoriesById)
    .filter((territoryId) =>
      !affectedTerritoryIds.has(territoryId as never) &&
      nextState.territoriesById[territoryId] &&
      beforeState.territoriesById[territoryId] !== nextState.territoriesById[territoryId]
    );
  const unaffectedTopologyEdgeReferenceChanges = Object.keys(beforeState.topology.edgesById)
    .filter((edgeId) =>
      !affectedTopologyEdgeIds.has(edgeId as never) &&
      nextState.topology.edgesById[edgeId] &&
      beforeState.topology.edgesById[edgeId] !== nextState.topology.edgesById[edgeId]
    ) as TopologyEdgeId[];

  return Object.freeze({
    unaffectedCountryReferenceChanges: sorted(unaffectedCountryReferenceChanges),
    unaffectedTerritoryReferenceChanges: sorted(unaffectedTerritoryReferenceChanges),
    unaffectedTopologyEdgeReferenceChanges: sorted(unaffectedTopologyEdgeReferenceChanges),
    deepCloneCount:
      unaffectedCountryReferenceChanges.length +
      unaffectedTerritoryReferenceChanges.length +
      unaffectedTopologyEdgeReferenceChanges.length,
  });
}

export function hasZeroUnnecessaryDeepClones(report: StructuralSharingReport) {
  return report.deepCloneCount === 0;
}
