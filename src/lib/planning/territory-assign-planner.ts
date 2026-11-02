import type {TerritoryAssignV2Command} from "../commands/territory-assign-v2";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import type {TerritoryEntity} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type TerritoryAssignPatch = Readonly<{
  kind: "territory.assign";
  territoryId: TerritoryId;
  beforeOwnerCountryId: null;
  afterOwnerCountryId: ActiveCountryId;
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

export function planTerritoryAssign(
  state: WorldStateV2,
  command: TerritoryAssignV2Command,
  context: PlannerContext,
): PlanResult<TerritoryAssignPatch> {
  return dryRunPlanner(state, command, context, () => {
    const territoryId = command.payload.territoryId as TerritoryId;
    const territory = state.territoriesById[territoryId];
    if (!territory) {
      return planningError(
        "territory-not-found",
        command.commandId,
        `TerritoryId is not active: ${territoryId}`,
      );
    }
    if (territory.ownerCountryId !== null) {
      return planningError(
        "territory-already-owned",
        command.commandId,
        `Territory ${territoryId} is already owned by ${territory.ownerCountryId}`,
      );
    }

    const targetCountryId = command.payload.targetCountryId as ActiveCountryId;
    if (!state.countriesById[targetCountryId]) {
      if (state.retiredCountryIds.has(targetCountryId as unknown as RetiredCountryId)) {
        return planningError(
          "country-id-retired",
          command.commandId,
          `Target CountryId is retired: ${targetCountryId}`,
        );
      }
      return planningError(
        "country-not-found",
        command.commandId,
        `Target CountryId is not active: ${targetCountryId}`,
      );
    }

    const assignedTerritory: TerritoryEntity = Object.freeze({
      ...territory,
      ownerCountryId: targetCountryId,
    });
    const territoriesById = Object.freeze({
      ...state.territoriesById,
      [territoryId]: assignedTerritory,
    });
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
        kind: "territory.assign",
        territoryId,
        beforeOwnerCountryId: null,
        afterOwnerCountryId: targetCountryId,
      }),
    });
  });
}
