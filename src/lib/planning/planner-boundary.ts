import type {MapCommandV2Envelope} from "../commands/map-command-v2";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, type PlanResult} from "./plan-result";

export type PlannerContext = Readonly<{
  committedCommandIds: ReadonlySet<string>;
}>;

export function planWithSemanticGuards<Patch>(
  state: WorldStateV2,
  command: MapCommandV2Envelope,
  context: PlannerContext,
  plan: () => PlanResult<Patch>,
): PlanResult<Patch> {
  if (command.expectedRevision !== state.revision) {
    return planningError(
      "stale-revision",
      command.commandId,
      `Expected revision ${command.expectedRevision} does not match ${state.revision}`,
    );
  }
  if (context.committedCommandIds.has(command.commandId)) {
    return planningError(
      "duplicate-command-id",
      command.commandId,
      `CommandId is already committed: ${command.commandId}`,
    );
  }
  return plan();
}

export function dryRunPlanner<Patch>(
  state: WorldStateV2,
  command: MapCommandV2Envelope,
  context: PlannerContext,
  plan: () => PlanResult<Patch>,
): PlanResult<Patch> {
  return planWithSemanticGuards(state, command, context, plan);
}
