import polygonClipping, {type MultiPolygon} from "polygon-clipping";

import type {TerritoryReplaceV2Command} from "../commands/territory-replace-v2";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {
  createTerritoryBBoxIndex,
} from "../world/territory-bbox-index";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import type {
  TerritoryEntity,
  TerritoryGeometry,
  TerritoryPosition,
} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import {recalculateTopologyIncrementally} from "../world/incremental-topology";
import {
  atomizeCanonicalTopologySegments,
  extractSharedTopologySegments,
  type CanonicalTopologySegment,
} from "../world/shared-segment";
import {
  normalizeTopologyGeometry,
  type TopologyGeometryPolicy,
} from "../world/topology-geometry-policy";
import {topologyEdgeLeafHash} from "../world/topology-edge-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type TerritoryReplacePolicy = TopologyGeometryPolicy & Readonly<{
  overlapAreaTolerance: number;
  sharedBoundaryTolerance: number;
}>;

export const DEFAULT_TERRITORY_REPLACE_POLICY: TerritoryReplacePolicy = Object.freeze({
  version: "world-policy-v1",
  coordinatePrecision: 9,
  exteriorRingWinding: "counterclockwise",
  minimumRingArea: 1e-12,
  overlapAreaTolerance: 1e-8,
  sharedBoundaryTolerance: 1e-8,
});

export type TerritoryReplaceMeasurements = Readonly<{
  overlapArea: number;
  uncoveredSharedBoundaryLength: number;
}>;

export type TerritoryReplacePatch = Readonly<{
  kind: "territory.replace";
  policyVersion: string;
  territoryId: TerritoryId;
  recomputedTerritoryIds: readonly TerritoryId[];
  measurements: TerritoryReplaceMeasurements;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const policyKeys = [
  "coordinatePrecision",
  "exteriorRingWinding",
  "minimumRingArea",
  "overlapAreaTolerance",
  "sharedBoundaryTolerance",
  "version",
] as const;

function readReplacePolicy(policy: TerritoryReplacePolicy): TerritoryReplacePolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("Territory replace policy must be an object");
  }
  const keys = Object.keys(policy).sort();
  if (keys.length !== policyKeys.length || keys.some((key, index) => key !== policyKeys[index])) {
    throw new TypeError("Territory replace policy contains unknown or missing fields");
  }
  if (typeof policy.version !== "string" || !policy.version || policy.version !== policy.version.trim()) {
    throw new TypeError("Territory replace policy version must be canonical text");
  }
  if (!Number.isInteger(policy.coordinatePrecision) || policy.coordinatePrecision < 0 || policy.coordinatePrecision > 15) {
    throw new RangeError("Territory replace precision must be an integer from 0 to 15");
  }
  if (policy.exteriorRingWinding !== "counterclockwise" && policy.exteriorRingWinding !== "clockwise") {
    throw new TypeError("Territory replace winding is invalid");
  }
  for (const [field, value] of [
    ["minimumRingArea", policy.minimumRingArea],
    ["overlapAreaTolerance", policy.overlapAreaTolerance],
    ["sharedBoundaryTolerance", policy.sharedBoundaryTolerance],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Territory replace ${field} must be finite and non-negative`);
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

const multiPolygonArea = (geometry: MultiPolygon) => geometry.reduce(
  (total, polygon) => total + Math.max(
    0,
    ringArea(polygon[0] as TerritoryPosition[]) - polygon.slice(1).reduce(
      (holes, ring) => holes + ringArea(ring as TerritoryPosition[]),
      0,
    ),
  ),
  0,
);

const segmentLength = (segment: CanonicalTopologySegment) => Math.hypot(
  segment[1][0] - segment[0][0],
  segment[1][1] - segment[0][1],
);

const uncoveredBoundaryLength = (
  oldSegments: readonly CanonicalTopologySegment[],
  newSegments: readonly CanonicalTopologySegment[],
  policy: TopologyGeometryPolicy,
) => atomizeCanonicalTopologySegments([
  {ownerKey: "new", segments: newSegments},
  {ownerKey: "old", segments: oldSegments},
], policy)
  .filter(({ownerKeys}) => ownerKeys.length === 1 && ownerKeys[0] === "old")
  .reduce((length, {segment}) => length + segmentLength(segment), 0);

const territoryHashRecord = (
  territoriesById: WorldStateV2["territoriesById"],
  policy: TopologyGeometryPolicy,
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

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Invalid Territory replacement";

export function planTerritoryReplace(
  state: WorldStateV2,
  command: TerritoryReplaceV2Command,
  context: PlannerContext,
  policyInput: TerritoryReplacePolicy = DEFAULT_TERRITORY_REPLACE_POLICY,
): PlanResult<TerritoryReplacePatch> {
  return dryRunPlanner(state, command, context, () => {
    let policy: TerritoryReplacePolicy;
    try {
      policy = readReplacePolicy(policyInput);
    } catch (error) {
      return planningError("policy-invalid", command.commandId, errorMessage(error));
    }
    if (policy.version !== state.policyVersion) {
      return planningError(
        "policy-version-mismatch",
        command.commandId,
        `Replace policy ${policy.version} does not match WorldState policy ${state.policyVersion}`,
      );
    }

    const territoryId = command.payload.territoryId as TerritoryId;
    const current = state.territoriesById[territoryId];
    if (!current) {
      return planningError(
        "territory-not-found",
        command.commandId,
        `TerritoryId is not active: ${territoryId}`,
      );
    }
    const topologyPolicy: TopologyGeometryPolicy = Object.freeze({
      version: policy.version,
      coordinatePrecision: policy.coordinatePrecision,
      exteriorRingWinding: policy.exteriorRingWinding,
      minimumRingArea: policy.minimumRingArea,
    });
    let geometry: TerritoryGeometry;
    try {
      geometry = normalizeTopologyGeometry(command.payload.geometry, topologyPolicy);
    } catch (error) {
      return planningError(
        "territory-geometry-invalid",
        command.commandId,
        errorMessage(error),
      );
    }

    let overlapArea = 0;
    try {
      const replacement = geometryToMultiPolygon(geometry);
      for (const [otherId, other] of Object.entries(state.territoriesById)) {
        if (otherId === territoryId) continue;
        overlapArea += multiPolygonArea(
          polygonClipping.intersection(replacement, geometryToMultiPolygon(other.geometry)),
        );
      }
    } catch (error) {
      return planningError(
        "territory-geometry-invalid",
        command.commandId,
        errorMessage(error),
      );
    }
    if (overlapArea > policy.overlapAreaTolerance) {
      return planningError(
        "territory-replace-overlap",
        command.commandId,
        `Replacement overlaps other Territories by ${overlapArea}`,
      );
    }

    const oldNeighborIds = state.topology.neighborTerritoryIdsById[territoryId] ?? [];
    let missingBoundaryLength = 0;
    for (const neighborId of oldNeighborIds) {
      const neighbor = state.territoriesById[neighborId];
      const oldShared = extractSharedTopologySegments(current.geometry, neighbor.geometry, topologyPolicy);
      const newShared = extractSharedTopologySegments(geometry, neighbor.geometry, topologyPolicy);
      missingBoundaryLength += uncoveredBoundaryLength(oldShared, newShared, topologyPolicy);
    }
    if (missingBoundaryLength > policy.sharedBoundaryTolerance) {
      return planningError(
        "territory-replace-gap",
        command.commandId,
        `Replacement leaves ${missingBoundaryLength} of prior shared boundary uncovered`,
      );
    }

    const replacement: TerritoryEntity = Object.freeze({...current, geometry});
    const territoriesById = Object.freeze({...state.territoriesById, [territoryId]: replacement});
    const topologyResult = recalculateTopologyIncrementally(
      state.topology,
      createTerritoryBBoxIndex(state.territoriesById),
      territoriesById,
      [territoryId],
      topologyPolicy,
    );
    const measurements: TerritoryReplaceMeasurements = Object.freeze({
      overlapArea,
      uncoveredSharedBoundaryLength: missingBoundaryLength,
    });
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      territoriesById,
      topology: topologyResult.topology,
      hashRoots: Object.freeze({
        ...state.hashRoots,
        territoriesRootHash: buildDomainRootHash(
          "territories",
          territoryHashRecord(territoriesById, topologyPolicy),
        ),
        topologyRootHash: buildDomainRootHash(
          "topology",
          topologyHashRecord(topologyResult.topology),
        ),
      }),
    });

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState,
      patch: Object.freeze({
        kind: "territory.replace",
        policyVersion: policy.version,
        territoryId,
        recomputedTerritoryIds: topologyResult.recomputedTerritoryIds,
        measurements,
      }),
    });
  });
}
