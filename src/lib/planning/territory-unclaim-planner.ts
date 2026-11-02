import type {TerritoryUnclaimV2Command} from "../commands/territory-unclaim-v2";
import type {ActiveCountryId} from "../world/country-id";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import type {TerritoryEntity} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type TerritoryUnclaimOwnershipChange = Readonly<{
  territoryId: TerritoryId;
  beforeOwnerCountryId: ActiveCountryId;
  afterOwnerCountryId: null;
}>;

export type TerritoryUnclaimPatch = Readonly<{
  kind: "territory.unclaim";
  alreadyUnclaimedPolicy: "reject";
  ownershipChanges: readonly TerritoryUnclaimOwnershipChange[];
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const TERRITORY_HASH_GEOMETRY_POLICY = Object.freeze({
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise" as const,
});

const territoryHashRecord = (territoriesById: WorldStateV2["territoriesById"]) =>
  Object.fromEntries(
    Object.entries(territoriesById)
      .sort(([left], [right]) => compareText(left, right))
      .flatMap(([territoryId, territory]) => [
        [
          `geometry:${territoryId}`,
          territoryGeometryLeafHash(territory, TERRITORY_HASH_GEOMETRY_POLICY),
        ],
        [`ownership:${territoryId}`, territoryOwnershipLeafHash(territory)],
      ]),
  );

export function planTerritoryUnclaim(
  state: WorldStateV2,
  command: TerritoryUnclaimV2Command,
  context: PlannerContext,
): PlanResult<TerritoryUnclaimPatch> {
  return dryRunPlanner(state, command, context, () => {
    const territoryIds = command.payload.territoryIds as TerritoryId[];
    if (new Set(territoryIds).size !== territoryIds.length) {
      return planningError(
        "territory-id-duplicate",
        command.commandId,
        "territory.unclaim requires unique TerritoryIds",
      );
    }
    const orderedTerritoryIds = [...territoryIds].sort(compareText);
    const ownershipChanges: TerritoryUnclaimOwnershipChange[] = [];
    for (const territoryId of orderedTerritoryIds) {
      const territory = state.territoriesById[territoryId];
      if (!territory) {
        return planningError(
          "territory-not-found",
          command.commandId,
          `TerritoryId is not active: ${territoryId}`,
        );
      }
      if (territory.ownerCountryId === null) {
        return planningError(
          "territory-already-unclaimed",
          command.commandId,
          `Territory ${territoryId} is already unclaimed; policy is reject`,
        );
      }
      ownershipChanges.push(Object.freeze({
        territoryId,
        beforeOwnerCountryId: territory.ownerCountryId,
        afterOwnerCountryId: null,
      }));
    }

    const territoriesByIdMutable = {...state.territoriesById};
    for (const {territoryId} of ownershipChanges) {
      const territory = territoriesByIdMutable[territoryId];
      territoriesByIdMutable[territoryId] = Object.freeze({
        ...territory,
        ownerCountryId: null,
      }) as TerritoryEntity;
    }
    const territoriesById = Object.freeze(territoriesByIdMutable);
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      territoriesById,
      hashRoots: Object.freeze({
        ...state.hashRoots,
        territoriesRootHash: buildDomainRootHash(
          "territories",
          territoryHashRecord(territoriesById),
        ),
      }),
    });

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState,
      patch: Object.freeze({
        kind: "territory.unclaim",
        alreadyUnclaimedPolicy: "reject",
        ownershipChanges: Object.freeze(ownershipChanges),
      }),
    });
  });
}
