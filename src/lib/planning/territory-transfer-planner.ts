import type {TerritoryTransferV2Command} from "../commands/territory-transfer-v2";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import type {TerritoryEntity, TerritoryGeometry, TerritoryPosition} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type TerritoryTransferMeasurements = Readonly<{
  areaBefore: number;
  areaAfter: number;
  areaDifference: number;
  geometryHashBefore: string;
  geometryHashAfter: string;
}>;

export type TerritoryTransferPatch = Readonly<{
  kind: "territory.transfer";
  territoryId: TerritoryId;
  beforeOwnerCountryId: ActiveCountryId;
  afterOwnerCountryId: ActiveCountryId;
  measurements: TerritoryTransferMeasurements;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const TERRITORY_HASH_GEOMETRY_POLICY = Object.freeze({
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise" as const,
});

const ringArea = (ring: readonly TerritoryPosition[]) => Math.abs(
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2,
);

const geometryArea = (geometry: TerritoryGeometry) => {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, polygon) => total + Math.max(
    0,
    ringArea(polygon[0]) - polygon.slice(1).reduce(
      (holes, hole) => holes + ringArea(hole),
      0,
    ),
  ), 0);
};

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

export function planTerritoryTransfer(
  state: WorldStateV2,
  command: TerritoryTransferV2Command,
  context: PlannerContext,
): PlanResult<TerritoryTransferPatch> {
  return dryRunPlanner(state, command, context, () => {
    if (command.payload.source.kind === "partition-result") {
      return planningError(
        "partition-result-unresolved",
        command.commandId,
        `Partition result ${command.payload.source.commandId}:${command.payload.source.partitionKey} must be resolved by the batch planner`,
      );
    }

    const territoryId = command.payload.source.territoryId as TerritoryId;
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
        "territory-unclaimed",
        command.commandId,
        `Territory ${territoryId} has no source owner; use territory.assign`,
      );
    }

    const sourceCountryId = territory.ownerCountryId;
    const targetCountryId = command.payload.targetCountryId as ActiveCountryId;
    if (targetCountryId === sourceCountryId) {
      return planningError(
        "country-target-self",
        command.commandId,
        `Transfer target cannot equal source CountryId ${sourceCountryId}`,
      );
    }
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

    const areaBefore = geometryArea(territory.geometry);
    const geometryHashBefore = territoryGeometryLeafHash(
      territory,
      TERRITORY_HASH_GEOMETRY_POLICY,
    );
    const transferredTerritory: TerritoryEntity = Object.freeze({
      ...territory,
      ownerCountryId: targetCountryId,
    });
    const areaAfter = geometryArea(transferredTerritory.geometry);
    const geometryHashAfter = territoryGeometryLeafHash(
      transferredTerritory,
      TERRITORY_HASH_GEOMETRY_POLICY,
    );
    const measurements: TerritoryTransferMeasurements = Object.freeze({
      areaBefore,
      areaAfter,
      areaDifference: Math.abs(areaBefore - areaAfter),
      geometryHashBefore,
      geometryHashAfter,
    });
    const territoriesById = Object.freeze({
      ...state.territoriesById,
      [territoryId]: transferredTerritory,
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
        kind: "territory.transfer",
        territoryId,
        beforeOwnerCountryId: sourceCountryId,
        afterOwnerCountryId: targetCountryId,
        measurements,
      }),
    });
  });
}
