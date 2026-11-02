import type {
  CommandBatchV2Command,
  LeafMapCommandV2,
} from "../commands/command-batch-v2";
import type {WorldStateV2} from "../world/world-state-v2";
import {resolveCommandBatchLocalReferences} from "./batch-local-reference-resolver";
import {planCountryCreate} from "./country-create-planner";
import {planCountryDelete} from "./country-delete-planner";
import {planCountryDissolve} from "./country-dissolve-planner";
import {planCountryEstablish} from "./country-establish-planner";
import {planCountryMerge} from "./country-merge-planner";
import {planCountryRename} from "./country-rename-planner";
import {planCountrySplit} from "./country-split-planner";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";
import {planTerritoryAssign} from "./territory-assign-planner";
import {planTerritoryPartition} from "./territory-partition-planner";
import {planTerritoryReplace} from "./territory-replace-planner";
import {planTerritoryTransfer} from "./territory-transfer-planner";
import {planTerritoryUnclaim} from "./territory-unclaim-planner";

export type CommandBatchPatch = Readonly<{
  kind: "command.batch";
  commandPatches: readonly unknown[];
}>;

const withExpectedRevision = <Command extends LeafMapCommandV2>(
  command: Command,
  expectedRevision: number,
): Command => ({...command, expectedRevision});

function planLeafCommand(
  state: WorldStateV2,
  command: LeafMapCommandV2,
  context: PlannerContext,
): PlanResult<unknown> {
  switch (command.type) {
    case "country.create":
      return planCountryCreate(state, withExpectedRevision(command, state.revision), context);
    case "country.rename":
      return planCountryRename(state, withExpectedRevision(command, state.revision), context);
    case "country.establish":
      return planCountryEstablish(state, withExpectedRevision(command, state.revision), context);
    case "country.delete":
      return planCountryDelete(state, withExpectedRevision(command, state.revision), context);
    case "country.dissolve":
      return planCountryDissolve(state, withExpectedRevision(command, state.revision), context);
    case "territory.partition":
      return planTerritoryPartition(state, withExpectedRevision(command, state.revision), context);
    case "territory.assign":
      return planTerritoryAssign(state, withExpectedRevision(command, state.revision), context);
    case "territory.unclaim":
      return planTerritoryUnclaim(state, withExpectedRevision(command, state.revision), context);
    case "territory.replace":
      return planTerritoryReplace(state, withExpectedRevision(command, state.revision), context);
    case "territory.transfer":
      return planTerritoryTransfer(state, withExpectedRevision(command, state.revision), context);
    case "country.split":
      return planCountrySplit(state, withExpectedRevision(command, state.revision), context);
    case "country.merge":
      return planCountryMerge(state, withExpectedRevision(command, state.revision), context);
    default:
      const unsupported = command as LeafMapCommandV2;
      return planningError(
        "batch-command-unsupported",
        unsupported.commandId,
        `No stage 10 planner is registered for command type: ${unsupported.type}`,
      );
  }
}

export function planCommandBatch(
  state: WorldStateV2,
  command: CommandBatchV2Command,
  context: PlannerContext,
): PlanResult<CommandBatchPatch> {
  return dryRunPlanner(state, command, context, () => {
    const resolved = resolveCommandBatchLocalReferences(command);
    if (!resolved.ok) {
      return Object.freeze({ok: false, error: resolved.error});
    }

    let cursorState = state;
    const seenCommandIds = new Set(context.committedCommandIds);
    seenCommandIds.add(command.commandId);
    const commandPatches: unknown[] = [];

    for (const leafCommand of resolved.batch.payload.commands as LeafMapCommandV2[]) {
      const result = planLeafCommand(
        cursorState,
        leafCommand,
        {committedCommandIds: seenCommandIds},
      );
      if (!result.ok) {
        return result;
      }
      cursorState = result.plan.nextState;
      commandPatches.push(result.plan.patch);
      seenCommandIds.add(leafCommand.commandId);
    }

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState: cursorState,
      patch: Object.freeze({
        kind: "command.batch",
        commandPatches: Object.freeze(commandPatches),
      }),
    });
  });
}
