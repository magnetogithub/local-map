import {z} from "zod";

import {
  countryIdSchema,
  isoCalendarDateSchema,
  MAX_PLAYER_ACTION_LENGTH,
  MAX_ACTIVE_PLAYER_ACTIONS,
  MAX_SIMULATION_EVENTS,
  MAX_SIMULATION_EVENT_CAUSES,
  simulationIdSchema,
  SimulationContractError,
} from "./simulation-contract-primitives";
import type {SimulationEventV1} from "./simulation-event";

export const queuedPlayerActionStatusSchema = z.enum([
  "queued",
  "resolving",
  "resolved",
  "cancelled",
]);

export const queuedPlayerActionSchema = z.strictObject({
  actionId: simulationIdSchema,
  actorCountryId: countryIdSchema,
  submittedAtDate: isoCalendarDateSchema,
  text: z.string().trim().min(1).max(MAX_PLAYER_ACTION_LENGTH),
  visibility: z.enum(["public", "private"]),
  status: queuedPlayerActionStatusSchema,
});

export type QueuedPlayerActionV1 = z.infer<typeof queuedPlayerActionSchema>;

// Loading preserves older queues. Registration and turn preparation use the 32-action policy.
export const MAX_LEGACY_ACTIVE_PLAYER_ACTIONS = 128;
export const MAX_RECENT_TERMINAL_PLAYER_ACTIONS = 128;
export const MAX_RETAINED_TERMINAL_PLAYER_ACTIONS =
  MAX_SIMULATION_EVENTS * (MAX_SIMULATION_EVENT_CAUSES + 1) + MAX_RECENT_TERMINAL_PLAYER_ACTIONS;

export function isActivePlayerAction(action: Pick<QueuedPlayerActionV1, "status">): boolean {
  return action.status === "queued" || action.status === "resolving";
}

export function activePlayerActionCount(actions: readonly Pick<QueuedPlayerActionV1, "status">[]): number {
  return actions.filter(isActivePlayerAction).length;
}

export const queuedPlayerActionsSchema = z.array(queuedPlayerActionSchema)
  .max(MAX_LEGACY_ACTIVE_PLAYER_ACTIONS + MAX_RETAINED_TERMINAL_PLAYER_ACTIONS)
  .superRefine((actions, context) => {
    const active = activePlayerActionCount(actions);
    if (active > MAX_LEGACY_ACTIVE_PLAYER_ACTIONS) {
      context.addIssue({code: "custom", message: "Stored active actions exceed the legacy compatibility bound"});
    }
    if (actions.length - active > MAX_RETAINED_TERMINAL_PLAYER_ACTIONS) {
      context.addIssue({code: "custom", message: "Stored terminal actions exceed the bounded retention policy"});
    }
  });

export function assertPlayerActionsCanAdvance(actions: readonly QueuedPlayerActionV1[]): void {
  if (activePlayerActionCount(actions) > MAX_ACTIVE_PLAYER_ACTIONS) {
    throw new SimulationContractError("ACTION_QUEUE_LIMIT_REACHED",
      `Cancel active actions until at most ${MAX_ACTIVE_PLAYER_ACTIONS} remain before advancing`);
  }
}

/** Mutation-only retention: never normalize a loaded snapshot or its canonical hash. */
export function retainPlayerActions(
  actions: readonly QueuedPlayerActionV1[],
  eventLog: readonly SimulationEventV1[],
): readonly QueuedPlayerActionV1[] {
  const referenced = new Set<string>();
  for (const event of eventLog) {
    for (const cause of event.causes) if (cause.kind === "queued-action") referenced.add(cause.id);
    if (event.referenceLifecycle?.kind === "queued-action") referenced.add(event.referenceLifecycle.referenceId);
  }
  const recent = new Set(actions.filter(action => !isActivePlayerAction(action) && !referenced.has(action.actionId))
    .slice(-MAX_RECENT_TERMINAL_PLAYER_ACTIONS).map(action => action.actionId));
  return Object.freeze(actions.filter(action =>
    isActivePlayerAction(action) || referenced.has(action.actionId) || recent.has(action.actionId)));
}

export type QueuePlayerActionInput = Readonly<{
  actionId: string;
  playerCountryId: string;
  submittedAtDate: string;
  text: string;
  visibility?: "public" | "private";
}>;

export function queuePlayerAction(
  actions: readonly QueuedPlayerActionV1[],
  input: QueuePlayerActionInput,
): readonly QueuedPlayerActionV1[] {
  const current = actions.map((action) => queuedPlayerActionSchema.parse(action));
  if (activePlayerActionCount(current) >= MAX_ACTIVE_PLAYER_ACTIONS) {
    throw new SimulationContractError("ACTION_QUEUE_LIMIT_REACHED",
      `At most ${MAX_ACTIVE_PLAYER_ACTIONS} active player actions can be queued`);
  }
  if (current.some((action) => action.actionId === input.actionId)) {
    throw new SimulationContractError(
      "DUPLICATE_ACTION_ID",
      `Duplicate queued action id: ${input.actionId}`,
    );
  }
  const action = queuedPlayerActionSchema.parse({
    actionId: input.actionId,
    actorCountryId: input.playerCountryId,
    submittedAtDate: input.submittedAtDate,
    text: input.text,
    visibility: input.visibility ?? "public",
    status: "queued",
  });
  return Object.freeze([...current, Object.freeze(action)]);
}

export function cancelQueuedPlayerAction(
  actions: readonly QueuedPlayerActionV1[],
  actionId: string,
  playerCountryId: string,
): readonly QueuedPlayerActionV1[] {
  let found = false;
  const next = actions.map((rawAction) => {
    const action = queuedPlayerActionSchema.parse(rawAction);
    if (action.actionId !== actionId) return action;
    found = true;
    if (action.actorCountryId !== playerCountryId) {
      throw new SimulationContractError(
        "INVALID_ACTION",
        "Player country cannot cancel another actor's action",
      );
    }
    if (action.status !== "queued" && !(action.status === "resolving"
      && activePlayerActionCount(actions) > MAX_ACTIVE_PLAYER_ACTIONS)) {
      throw new SimulationContractError(
        "ACTION_NOT_CANCELLABLE",
        `Action ${actionId} is ${action.status}`,
      );
    }
    return Object.freeze({...action, status: "cancelled" as const});
  });
  if (!found) {
    throw new SimulationContractError("INVALID_ACTION", `Unknown queued action: ${actionId}`);
  }
  return Object.freeze(next);
}

