import {
  applyGlyphResult,
  type LabelProjection,
  type LabelWorkerResult,
} from "../projection/label-projection-checkpoint";
import {
  applyProjectionCoordinatorPatch,
  retryFailedProjections,
  type ProjectionAdapter,
  type ProjectionCoordinator,
} from "../projection/map-projection-checkpoint";
import type {WorldStateV2} from "../world/world-state-v2";
import {
  redoHistory,
  undoHistory,
  type WorldHistory,
} from "./history-persistence-checkpoint";
import type {PlanResult} from "./plan-result";
import type {WorldPatchV2} from "./world-patch-v2";

export type BoundedTiming = Readonly<{
  name: string;
  iterations: number;
  elapsedMs: number;
  averageMs: number;
}>;

export type HashDeltaPerformanceSummary = Readonly<{
  changedRootCount: number;
  changedLeafCount: number;
  totalLeafCount: number;
  leafTouchRatio: number;
  avoidedFullLeafRebuild: boolean;
}>;

export type PlannerPerformanceSummary = Readonly<{
  timings: readonly BoundedTiming[];
  failedOperationNames: readonly string[];
}>;

export type GuardedHistoryResult = Readonly<{
  history: WorldHistory;
  state: WorldStateV2;
  staleRejected: boolean;
}>;

export type ProjectionFailureInjectionResult = Readonly<{
  failedProjectionNames: readonly string[];
  retainedRevision: number;
  retainedArtifactHash: string;
  retriedRevision: number;
  recovered: boolean;
}>;

export type WorkerFailureInjectionResult = Readonly<{
  projection: LabelProjection;
  accepted: boolean;
  failureCount: number;
}>;

const count = <T>(values: readonly T[]) => values.length;

const elapsed = (startedAt: number) => Math.max(0, performance.now() - startedAt);

export function runBoundedTiming(
  name: string,
  iterations: number,
  operation: () => void,
): BoundedTiming {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 5) {
    throw new Error("Checkpoint timing iterations must stay between 1 and 5");
  }
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) operation();
  const elapsedMs = elapsed(startedAt);
  return Object.freeze({
    name,
    iterations,
    elapsedMs,
    averageMs: elapsedMs / iterations,
  });
}

export function summarizeIncrementalHashDeltas(
  patch: WorldPatchV2,
  totalLeafCount: number,
): HashDeltaPerformanceSummary {
  if (!Number.isSafeInteger(totalLeafCount) || totalLeafCount < 0) {
    throw new Error("totalLeafCount must be a non-negative safe integer");
  }
  const changedRootCount = Object.values(patch.moduleHashDeltas)
    .filter((delta) => delta !== null)
    .length;
  const changedLeafCount =
    count(patch.moduleLeafHashDeltas.countryCore) +
    count(patch.moduleLeafHashDeltas.countryPresentation) +
    count(patch.moduleLeafHashDeltas.territoryGeometry) +
    count(patch.moduleLeafHashDeltas.territoryOwnership) +
    count(patch.moduleLeafHashDeltas.topologyEdge);
  return Object.freeze({
    changedRootCount,
    changedLeafCount,
    totalLeafCount,
    leafTouchRatio: totalLeafCount === 0 ? 0 : changedLeafCount / totalLeafCount,
    avoidedFullLeafRebuild: changedLeafCount < totalLeafCount,
  });
}

export function measurePlannerOperations(
  operations: Readonly<Record<string, () => PlanResult<unknown>>>,
  iterations = 1,
): PlannerPerformanceSummary {
  const failedOperationNames: string[] = [];
  const timings = Object.entries(operations).map(([name, operation]) =>
    runBoundedTiming(name, iterations, () => {
      const result = operation();
      if (!result.ok) failedOperationNames.push(name);
    })
  );
  return Object.freeze({
    timings: Object.freeze(timings),
    failedOperationNames: Object.freeze([...new Set(failedOperationNames)].sort()),
  });
}

export function undoHistoryWithRevisionGuard(
  history: WorldHistory,
  state: WorldStateV2,
  expectedRevision: number,
): GuardedHistoryResult {
  if (state.revision !== expectedRevision || history.currentRevision !== expectedRevision) {
    return Object.freeze({history, state, staleRejected: true});
  }
  return Object.freeze({...undoHistory(history, state), staleRejected: false});
}

export function redoHistoryWithRevisionGuard(
  history: WorldHistory,
  state: WorldStateV2,
  expectedRevision: number,
): GuardedHistoryResult {
  if (state.revision !== expectedRevision || history.currentRevision !== expectedRevision) {
    return Object.freeze({history, state, staleRejected: true});
  }
  return Object.freeze({...redoHistory(history, state), staleRejected: false});
}

export function injectProjectionFailureAndRetry(
  coordinator: ProjectionCoordinator,
  adapters: readonly ProjectionAdapter[],
  patch: WorldPatchV2,
  committedState: WorldStateV2,
  latestState: WorldStateV2,
): ProjectionFailureInjectionResult {
  const failed = applyProjectionCoordinatorPatch(coordinator, adapters, patch, committedState);
  const [failedName] = failed.failedProjectionNames;
  const failedRecord = failedName
    ? failed.coordinator.records.get(failedName)
    : undefined;
  if (!failedRecord) {
    throw new Error("Projection failure injection did not produce a failed projection record");
  }
  const retainedRevision = failedRecord.meta.appliedRevision;
  const retainedArtifactHash = failedRecord.meta.artifactHash;
  const retried = retryFailedProjections(failed.coordinator, adapters, latestState);
  const retriedRecord = retried.records.get(failedName);
  return Object.freeze({
    failedProjectionNames: failed.failedProjectionNames,
    retainedRevision,
    retainedArtifactHash,
    retriedRevision: retriedRecord?.meta.appliedRevision ?? retainedRevision,
    recovered: retriedRecord?.status === "ready" &&
      retriedRecord.meta.appliedRevision === latestState.revision,
  });
}

export function applyWorkerResultWithFailureGuard(
  projection: LabelProjection,
  resultFactory: () => LabelWorkerResult,
): WorkerFailureInjectionResult {
  try {
    const nextProjection = applyGlyphResult(projection, resultFactory());
    return Object.freeze({
      projection: nextProjection,
      accepted: nextProjection !== projection,
      failureCount: 0,
    });
  } catch {
    return Object.freeze({
      projection,
      accepted: false,
      failureCount: 1,
    });
  }
}
