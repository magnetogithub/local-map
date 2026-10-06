import {z} from "zod";

import {
  factMutationSchema,
  scheduledConsequenceSchema,
  situationMutationSchema,
} from "./narrative-state";
import {playerActionOutcomeSchema, simulationEventSchema} from "./simulation-event";
import {
  boundedSummarySchema,
  assertSafeSimulationData,
  isoCalendarDateSchema,
  SIMULATION_CONTRACT_VERSION,
} from "./simulation-contract-primitives";
import {worldEffectSchema} from "./world-effect";
import type {SimulationEventV1} from './simulation-event';

// Lifecycle metadata is written by the host; GPT's submit schema must never request it.
const turnResolutionEventSchema:z.ZodType<SimulationEventV1>=simulationEventSchema.omit({authorityLifecycle:true,referenceLifecycle:true});

export const TURN_RESOLUTION_LIMITS = Object.freeze({
  playerActionOutcomes: 32,
  events: 64,
  factMutations: 64,
  situationMutations: 64,
  scheduledConsequences: 64,
  worldEffects: 32,
  unresolvedQuestions: 32,
});

export const turnPeriodSchema = z.strictObject({
  startDate: isoCalendarDateSchema,
  endDate: isoCalendarDateSchema,
});

export const turnResolutionSchema = z.strictObject({
  contractVersion: z.literal(SIMULATION_CONTRACT_VERSION),
  baseSimulationRevision: z.number().int().nonnegative(),
  baseWorldRevision: z.number().int().nonnegative(),
  period: turnPeriodSchema,
  playerActionOutcomes: z.array(playerActionOutcomeSchema)
    .max(TURN_RESOLUTION_LIMITS.playerActionOutcomes),
  events: z.array(turnResolutionEventSchema).max(TURN_RESOLUTION_LIMITS.events),
  factMutations: z.array(factMutationSchema).max(TURN_RESOLUTION_LIMITS.factMutations),
  situationMutations: z.array(situationMutationSchema)
    .max(TURN_RESOLUTION_LIMITS.situationMutations),
  scheduledConsequences: z.array(scheduledConsequenceSchema)
    .max(TURN_RESOLUTION_LIMITS.scheduledConsequences),
  worldEffects: z.array(worldEffectSchema).max(TURN_RESOLUTION_LIMITS.worldEffects),
  advisorSummary: boundedSummarySchema,
  unresolvedQuestions: z.array(boundedSummarySchema)
    .max(TURN_RESOLUTION_LIMITS.unresolvedQuestions),
});

export type TurnResolutionV1 = z.infer<typeof turnResolutionSchema>;

export const parseTurnResolutionV1 = (input: unknown): TurnResolutionV1 => {
  assertSafeSimulationData(input);
  if(input&&typeof input==='object'&&'events' in input&&Array.isArray(input.events)
    &&input.events.some(e=>e&&typeof e==='object'&&(Object.hasOwn(e,'authorityLifecycle')||Object.hasOwn(e,'referenceLifecycle'))))throw new Error('HOST_OWNED_LIFECYCLE_EVENT');
  return turnResolutionSchema.parse(input);
};

export type JsonSchemaObject = Record<string, unknown>;

function normalizeFunctionSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFunctionSchema);
  if (typeof value !== "object" || value === null) return value;
  const result=Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key === "oneOf" ? "anyOf" : key,
    normalizeFunctionSchema(child),
  ]));
  if(result.properties&&typeof result.properties==='object'&&'regionRefs'in result.properties)result.required=[...new Set([...(result.required as string[]??[]),'regionRefs'])];
  return result;
}

/**
 * Returns the exact root-object schema used by the future submit_turn_resolution tool.
 * Semantic checks intentionally remain host-side and are not delegated to JSON Schema.
 */
export function createTurnResolutionFunctionParametersSchema(): JsonSchemaObject {
  const schema = normalizeFunctionSchema(
    z.toJSONSchema(turnResolutionSchema, {target: "draft-7",io:'input'}),
  ) as JsonSchemaObject;
  if (schema.type !== "object" || "anyOf" in schema || schema.additionalProperties !== false) {
    throw new Error("TurnResolution tool schema must be a strict root object without root anyOf");
  }
  return schema;
}

