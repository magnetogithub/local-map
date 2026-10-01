import {z} from "zod";

import {
  countryIdSchema,
  isoCalendarDateSchema,
  MAX_PLAYER_ACTION_LENGTH,
  simulationIdSchema,
  SimulationContractError,
} from "./simulation-contract-primitives";

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
    if (action.status !== "queued") {
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

