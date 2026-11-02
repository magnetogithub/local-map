import polygonClipping, {type MultiPolygon} from "polygon-clipping";

import type {TerritoryPartitionV2Command} from "../commands/territory-partition-v2";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createTerritoryBBoxIndex} from "../world/territory-bbox-index";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {
  createTerritoryEntity,
  type TerritoryEntity,
  type TerritoryGeometry,
  type TerritoryPosition,
} from "../world/territory-entity";
import {
  deriveTerritoryId,
  type TerritoryId,
} from "../world/territory-id";
import {partitionTerritoryOrder} from "../world/territory-order";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {recalculateTopologyIncrementally} from "../world/incremental-topology";
import {
  normalizeTopologyGeometry,
  type TopologyGeometryPolicy,
} from "../world/topology-geometry-policy";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type TerritoryPartitionPolicy = TopologyGeometryPolicy & Readonly<{
  booleanAreaTolerance: number;
  minimumPartitionArea: number;
}>;

export const DEFAULT_TERRITORY_PARTITION_POLICY: TerritoryPartitionPolicy = Object.freeze({
  version: "world-policy-v1",
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise",
  minimumRingArea: 1e-12,
  minimumPartitionArea: 1e-10,
  booleanAreaTolerance: 1e-5,
});

export type TerritoryPartitionMeasurements = Readonly<{
  sourceArea: number;
  partitionAreaSum: number;
  unionArea: number;
  gapArea: number;
  overlapArea: number;
  outsideSourceArea: number;
  areaConservationError: number;
}>;

export type TerritoryPartitionPatch = Readonly<{
  kind: "territory.partition";
  policyVersion: string;
  sourceTerritoryId: TerritoryId;
  partitionTerritoryIds: readonly TerritoryId[];
  measurements: TerritoryPartitionMeasurements;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const policyKeys = [
  "booleanAreaTolerance",
  "coordinatePrecision",
  "exteriorRingWinding",
  "minimumPartitionArea",
  "minimumRingArea",
  "version",
] as const;

function readPartitionPolicy(policy: TerritoryPartitionPolicy): TerritoryPartitionPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("Territory partition policy must be an object");
  }
  const keys = Object.keys(policy).sort();
  if (keys.length !== policyKeys.length || keys.some((key, index) => key !== policyKeys[index])) {
    throw new TypeError("Territory partition policy contains unknown or missing fields");
  }
  if (typeof policy.version !== "string" || !policy.version || policy.version !== policy.version.trim()) {
    throw new TypeError("Territory partition policy version must be canonical text");
  }
  if (!Number.isInteger(policy.coordinatePrecision) || policy.coordinatePrecision < 0 || policy.coordinatePrecision > 15) {
    throw new RangeError("Territory partition coordinate precision must be an integer from 0 to 15");
  }
  if (policy.exteriorRingWinding !== "counterclockwise" && policy.exteriorRingWinding !== "clockwise") {
    throw new TypeError("Territory partition winding is invalid");
  }
  for (const [field, value] of [
    ["minimumRingArea", policy.minimumRingArea],
    ["minimumPartitionArea", policy.minimumPartitionArea],
    ["booleanAreaTolerance", policy.booleanAreaTolerance],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Territory partition ${field} must be finite and non-negative`);
    }
  }
  return Object.freeze({...policy});
}

const geometryToMultiPolygon = (geometry: TerritoryGeometry): MultiPolygon =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as MultiPolygon;

const ringArea = (ring: readonly TerritoryPosition[]) => Math.abs(
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2,
);

const polygonArea = (polygon: readonly (readonly TerritoryPosition[])[]) => Math.max(
  0,
  ringArea(polygon[0]) - polygon.slice(1).reduce((area, hole) => area + ringArea(hole), 0),
);

const multiPolygonArea = (geometry: MultiPolygon) => geometry.reduce(
  (area, polygon) => area + polygonArea(polygon as TerritoryPosition[][]),
  0,
);

const territoryGeometryArea = (geometry: TerritoryGeometry) =>
  multiPolygonArea(geometryToMultiPolygon(geometry));

const territoryHashRecord = (
  territoriesById: WorldStateV2["territoriesById"],
  policy: TerritoryPartitionPolicy,
) => Object.fromEntries(
  Object.entries(territoriesById)
    .sort(([left], [right]) => compareText(left, right))
    .flatMap(([territoryId, territory]) => [
      [
        `geometry:${territoryId}`,
        territoryGeometryLeafHash(territory, {
          coordinatePrecision: policy.coordinatePrecision,
          exteriorRingWinding: policy.exteriorRingWinding,
        }),
      ],
      [`ownership:${territoryId}`, territoryOwnershipLeafHash(territory)],
    ]),
);

const topologyHashRecord = (topology: WorldStateV2["topology"]) => Object.fromEntries(
  Object.entries(topology.edgesById)
    .sort(([left], [right]) => compareText(left, right))
    .map(([edgeId, edge]) => [edgeId, topologyEdgeLeafHash(edge)]),
);

const invalidGeometryMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Invalid partition geometry";

export function planTerritoryPartition(
  state: WorldStateV2,
  command: TerritoryPartitionV2Command,
  context: PlannerContext,
  policyInput: TerritoryPartitionPolicy = DEFAULT_TERRITORY_PARTITION_POLICY,
): PlanResult<TerritoryPartitionPatch> {
  return dryRunPlanner(state, command, context, () => {
    let policy: TerritoryPartitionPolicy;
    try {
      policy = readPartitionPolicy(policyInput);
    } catch (error) {
      return planningError("policy-invalid", command.commandId, invalidGeometryMessage(error));
    }
    if (policy.version !== state.policyVersion) {
      return planningError(
        "policy-version-mismatch",
        command.commandId,
        `Partition policy ${policy.version} does not match WorldState policy ${state.policyVersion}`,
      );
    }

    const sourceTerritoryId = command.payload.sourceTerritoryId as TerritoryId;
    const source = state.territoriesById[sourceTerritoryId];
    if (!source) {
      return planningError(
        "territory-not-found",
        command.commandId,
        `TerritoryId is not active: ${sourceTerritoryId}`,
      );
    }

    const partitionKeys = command.payload.partitions.map(({partitionKey}) => partitionKey);
    if (new Set(partitionKeys).size !== partitionKeys.length) {
      return planningError(
        "partition-key-duplicate",
        command.commandId,
        "Territory partition keys must be unique",
      );
    }
    const partitionTerritoryIds = command.payload.partitions.map(({partitionKey}) =>
      deriveTerritoryId({kind: "partition", sourceTerritoryId, partitionKey})
    );
    const collision = partitionTerritoryIds.find((territoryId) =>
      Object.hasOwn(state.territoriesById, territoryId) && territoryId !== sourceTerritoryId
    );
    if (collision) {
      return planningError(
        "territory-id-collision",
        command.commandId,
        `Partition TerritoryId already exists: ${collision}`,
      );
    }

    const topologyPolicy: TopologyGeometryPolicy = Object.freeze({
      version: policy.version,
      coordinatePrecision: policy.coordinatePrecision,
      exteriorRingWinding: policy.exteriorRingWinding,
      minimumRingArea: policy.minimumRingArea,
    });
    let sourceGeometry: TerritoryGeometry;
    let partitionGeometries: readonly TerritoryGeometry[];
    try {
      sourceGeometry = normalizeTopologyGeometry(source.geometry, topologyPolicy);
      partitionGeometries = Object.freeze(command.payload.partitions.map(({geometry}) =>
        normalizeTopologyGeometry(geometry, topologyPolicy)
      ));
    } catch (error) {
      return planningError(
        "partition-geometry-invalid",
        command.commandId,
        invalidGeometryMessage(error),
      );
    }

    const partitionAreas = partitionGeometries.map(territoryGeometryArea);
    const belowMinimumIndex = partitionAreas.findIndex((area) => area < policy.minimumPartitionArea);
    if (belowMinimumIndex >= 0) {
      return planningError(
        "partition-area-below-minimum",
        command.commandId,
        `Partition ${partitionKeys[belowMinimumIndex]} area ${partitionAreas[belowMinimumIndex]} is below ${policy.minimumPartitionArea}`,
      );
    }

    let union: MultiPolygon;
    let gapArea: number;
    let outsideSourceArea: number;
    try {
      const partitionMultiPolygons = partitionGeometries.map(geometryToMultiPolygon);
      union = polygonClipping.union(partitionMultiPolygons[0], ...partitionMultiPolygons.slice(1));
      gapArea = multiPolygonArea(polygonClipping.difference(geometryToMultiPolygon(sourceGeometry), union));
      outsideSourceArea = multiPolygonArea(
        polygonClipping.difference(union, geometryToMultiPolygon(sourceGeometry)),
      );
    } catch (error) {
      return planningError(
        "partition-geometry-invalid",
        command.commandId,
        invalidGeometryMessage(error),
      );
    }
    const sourceArea = territoryGeometryArea(sourceGeometry);
    const partitionAreaSum = partitionAreas.reduce((sum, area) => sum + area, 0);
    const unionArea = multiPolygonArea(union);
    const overlapArea = Math.max(0, partitionAreaSum - unionArea);
    const areaConservationError = Math.abs(sourceArea - unionArea);
    const measurements: TerritoryPartitionMeasurements = Object.freeze({
      sourceArea,
      partitionAreaSum,
      unionArea,
      gapArea,
      overlapArea,
      outsideSourceArea,
      areaConservationError,
    });

    if (outsideSourceArea > policy.booleanAreaTolerance) {
      return planningError(
        "partition-outside-source",
        command.commandId,
        `Partition union extends outside source by ${outsideSourceArea}`,
      );
    }
    if (overlapArea > policy.booleanAreaTolerance) {
      return planningError(
        "partition-overlap",
        command.commandId,
        `Partition overlap area ${overlapArea} exceeds tolerance ${policy.booleanAreaTolerance}`,
      );
    }
    if (gapArea > policy.booleanAreaTolerance || areaConservationError > policy.booleanAreaTolerance) {
      return planningError(
        "partition-gap",
        command.commandId,
        `Partition gap area ${gapArea} exceeds tolerance ${policy.booleanAreaTolerance}`,
      );
    }

    const territoriesByIdMutable = Object.fromEntries(
      Object.entries(state.territoriesById).filter(([territoryId]) => territoryId !== sourceTerritoryId),
    ) as Record<string, TerritoryEntity>;
    command.payload.partitions.forEach((partition, index) => {
      const territoryId = partitionTerritoryIds[index];
      territoriesByIdMutable[territoryId] = createTerritoryEntity({
        id: territoryId,
        ownerCountryId: source.ownerCountryId,
        geometry: partitionGeometries[index],
        properties: source.properties,
      });
    });
    const territoriesById = Object.freeze(territoriesByIdMutable);
    const changedTerritoryIds = Object.freeze([sourceTerritoryId, ...partitionTerritoryIds]);
    const topology = recalculateTopologyIncrementally(
      state.topology,
      createTerritoryBBoxIndex(state.territoriesById),
      territoriesById,
      changedTerritoryIds,
      topologyPolicy,
    ).topology;
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      territoriesById,
      territoryOrder: partitionTerritoryOrder(
        state.territoryOrder,
        sourceTerritoryId,
        partitionTerritoryIds,
      ),
      topology,
      hashRoots: Object.freeze({
        ...state.hashRoots,
        territoriesRootHash: buildDomainRootHash(
          "territories",
          territoryHashRecord(territoriesById, policy),
        ),
        topologyRootHash: buildDomainRootHash("topology", topologyHashRecord(topology)),
      }),
    });

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState,
      patch: Object.freeze({
        kind: "territory.partition",
        policyVersion: policy.version,
        sourceTerritoryId,
        partitionTerritoryIds: Object.freeze([...partitionTerritoryIds].sort(compareText)),
        measurements,
      }),
    });
  });
}
